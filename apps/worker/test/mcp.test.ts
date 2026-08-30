import { env, SELF, runInDurableObject } from "cloudflare:test";
import { passwordVerifier, randomBase64Url, sha256Hex, verifySetupToken } from "../src/security.js";
import { runnerReleaseDescriptor } from "../src/index.js";
import { FIXED_ARTIFACT_URL, FIXED_RELEASE_KEY_ID, FIXED_RELEASE_PUBLIC_KEY_PEM, FIXED_RELEASE_VERSION, renderPosixInstaller, renderPowerShellInstaller } from "../src/installer.js";
import { describe, expect, it } from "vitest";

const password = "administrator-password-for-tests";
const setupToken = "test-setup-token-0123456789abcdef";

type CookieJar = Map<string, string>;

describe.sequential("self-hosted admin and MCP client authentication", () => {
  it("accepts only a configured plaintext or SHA-256 setup-token verifier", async () => {
    const token = "setup-token-for-hash-verifier";
    const hash = await sha256Hex(token);
    expect(await verifySetupToken(token, undefined, hash)).toBe(true);
    expect(await verifySetupToken(token, undefined, hash.toUpperCase())).toBe(true);
    expect(await verifySetupToken("wrong-setup-token", undefined, hash)).toBe(false);
    expect(await verifySetupToken(token, undefined, undefined)).toBe(false);
  });

  it("throttles login after five failed KDF attempts and clears it after a success", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`login-throttle-${crypto.randomUUID()}`));
    const now = Date.now();
    const verifier = await passwordVerifier(password);
    await runInDurableObject(registry, (instance) => {
      expect(instance.setupAdmin(verifier, now)).toBe(true);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(instance.checkAuthThrottle("login", now + attempt)).toEqual({ allowed: true, retry_after_ms: 0 });
        instance.recordAuthAttempt("login", false, now + attempt);
      }
      const blocked = instance.checkAuthThrottle("login", now + 5);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retry_after_ms).toBeGreaterThanOrEqual(29_000);
      instance.recordAuthAttempt("login", true, now + 6);
      expect(instance.checkAuthThrottle("login", now + 7)).toEqual({ allowed: true, retry_after_ms: 0 });
    });
  });

  it("reserves setup KDF attempts and exponentially backs off", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`setup-throttle-${crypto.randomUUID()}`));
    const now = Date.now();
    await runInDurableObject(registry, (instance) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(instance.checkAuthThrottle("setup", now + attempt)).toEqual({ allowed: true, retry_after_ms: 0 });
        instance.recordAuthAttempt("setup", false, now + attempt);
      }
      const firstBlock = instance.checkAuthThrottle("setup", now + 5);
      expect(firstBlock).toMatchObject({ allowed: false });
      expect(firstBlock.retry_after_ms).toBeGreaterThanOrEqual(29_000);
      const atExpiry = now + 31_000;
      expect(instance.checkAuthThrottle("setup", atExpiry)).toEqual({ allowed: true, retry_after_ms: 0 });
      instance.recordAuthAttempt("setup", false, atExpiry);
      const secondBlock = instance.checkAuthThrottle("setup", atExpiry + 1);
      expect(secondBlock.retry_after_ms).toBeGreaterThanOrEqual(59_000);
    });
  });

  it("recovers incomplete legacy policy identities once without deleting retained data", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`legacy-policy-recovery-${crypto.randomUUID()}`));
    const now = Date.now();
    await runInDurableObject(registry, (instance, state) => {
      const sql = state.storage.sql;
      instance.registerRunner("legacy-policy", "a".repeat(64), now);
      sql.exec("INSERT INTO managed_workspaces (runner_id, workspace_id, display_name, root_path, enabled, permissions_json, created_at_ms, updated_at_ms, revision) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1)", "legacy-policy", "workspace", "Workspace", "/tmp", JSON.stringify({ read: true, edit: false, shell: false, job_control: false }), now, now);
      sql.exec("INSERT INTO jobs (runner_id, job_id, job_json, updated_at_ms) VALUES (?, ?, ?, ?)", "legacy-policy", "retained-job", JSON.stringify({ job_id: "retained-job", workspace_id: "workspace", status: "succeeded" }), now);
      sql.exec("DELETE FROM runner_policy_migrations WHERE runner_id = ?", "legacy-policy");
      sql.exec("DELETE FROM runner_policy_versions WHERE runner_id = ?", "legacy-policy");
      sql.exec("UPDATE runners SET desired_policy_revision = 7, desired_policy_checksum = NULL, applied_policy_revision = 7, active_policy_checksum = ?, runner_reported_policy_revision = 7, runner_reported_policy_checksum = ?, policy_status = 'applied' WHERE runner_id = ?", "b".repeat(64), "b".repeat(64), "legacy-policy");
      (instance as unknown as { ensureSchema(): void }).ensureSchema();
      const recovered = instance.getRunner("legacy-policy");
      expect(recovered).toMatchObject({ desired_policy_revision: 8, applied_policy_revision: null, runner_reported_policy_revision: null, policy_status: "offline_pending" });
      expect(instance.listPolicyVersions("legacy-policy")).toMatchObject([{ revision: 8, status: "pending", mutation_id: "migration-revalidation-required" }]);
      expect(instance.getJob("legacy-policy", "retained-job")).toMatchObject({ job_id: "retained-job" });
      expect(instance.listManagedWorkspaces("legacy-policy")).toHaveLength(1);
      (instance as unknown as { ensureSchema(): void }).ensureSchema();
      expect(instance.listPolicyVersions("legacy-policy")).toHaveLength(1);
    });
  });

  it("retains a complete validated legacy snapshot during policy recovery", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`legacy-policy-complete-${crypto.randomUUID()}`));
    const now = Date.now();
    await runInDurableObject(registry, (instance, state) => {
      instance.addRunner("complete-policy", "Complete policy", now);
      const version = instance.listPolicyVersions("complete-policy")[0];
      expect(version).toBeDefined();
      state.storage.sql.exec("UPDATE runner_policy_versions SET status = 'applied' WHERE runner_id = ? AND revision = ?", "complete-policy", version?.revision);
      state.storage.sql.exec("UPDATE runners SET desired_policy_revision = ?, desired_policy_checksum = ?, applied_policy_revision = ?, active_policy_checksum = ?, runner_reported_policy_revision = ?, runner_reported_policy_checksum = ?, policy_status = 'applied' WHERE runner_id = ?", version?.revision, version?.checksum, version?.revision, version?.checksum, version?.revision, version?.checksum, "complete-policy");
      state.storage.sql.exec("DELETE FROM runner_policy_migrations WHERE runner_id = ?", "complete-policy");
      (instance as unknown as { ensureSchema(): void }).ensureSchema();
      expect(instance.getRunner("complete-policy")).toMatchObject({ desired_policy_revision: 1, applied_policy_revision: 1, policy_status: "applied" });
      expect(instance.listPolicyVersions("complete-policy")).toHaveLength(1);
    });
  });

  it("has safe additive schema defaults for legacy runner, MCP, enrollment, and sync data", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`schema-defaults-${crypto.randomUUID()}`));
    const now = Date.now();
    await runInDurableObject(registry, (instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE runners");
      sql.exec("DROP TABLE mcp_clients");
      sql.exec("DROP TABLE IF EXISTS runner_enrollments");
      sql.exec(`CREATE TABLE runners (
        runner_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, state TEXT NOT NULL, connection_epoch INTEGER NOT NULL DEFAULT 0,
        session_id TEXT, metadata_json TEXT, last_heartbeat_ms INTEGER, updated_at_ms INTEGER NOT NULL
      )`);
      sql.exec("INSERT INTO runners (runner_id, token_hash, state, updated_at_ms) VALUES ('legacy-row', ?, 'offline', ?)", "a".repeat(64), now);
      sql.exec(`CREATE TABLE mcp_clients (
        client_id TEXT PRIMARY KEY, label TEXT NOT NULL, secret_verifier TEXT NOT NULL UNIQUE, secret_prefix TEXT NOT NULL,
        scopes_json TEXT NOT NULL, secret_version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        last_used_at_ms INTEGER, revoked_at_ms INTEGER
      )`);
      sql.exec("INSERT INTO mcp_clients (client_id, label, secret_verifier, secret_prefix, scopes_json, created_at_ms, updated_at_ms) VALUES ('legacy-client', 'Legacy client', ?, 'legacy-prefix', '[\"coding:read\"]', ?, ?)", "b".repeat(64), now, now);
      (instance as unknown as { ensureSchema(): void }).ensureSchema();
      expect(instance.getRunner("legacy-row")).toMatchObject({ display_name: "legacy-row", public_info: null, last_sync_sequence: null, credential_version: 1, current_runner_version: null, protocol_compatibility: "unknown", update_channel: "stable", desired_runner_version: null, latest_runner_version: null, update_status: "unknown" });
      expect(instance.listMcpClients()).toContainEqual(expect.objectContaining({ client_id: "legacy-client", active_runner_id: null, active_runner_updated_at_ms: null }));
      expect(instance.createRunnerEnrollment("legacy-row", randomBase64Url(), "c".repeat(64), now)).toBeDefined();
    });
  });

  it("persists stable and pinned version policy without creating an MCP update surface", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`runner-version-policy-${crypto.randomUUID()}`)); const now = Date.now();
    await runInDurableObject(registry, (instance) => {
      instance.registerRunner("versioned-runner", "a".repeat(64), now);
      expect(instance.setRunnerVersionPolicy("versioned-runner", { update_channel: "stable", latest_runner_version: "1.2.3" }, now + 1)).toMatchObject({ update_channel: "stable", latest_runner_version: "1.2.3", update_status: "unknown" });
      expect(instance.setRunnerVersionPolicy("versioned-runner", { update_channel: "pinned", desired_runner_version: "1.2.0" }, now + 2)).toMatchObject({ update_channel: "pinned", desired_runner_version: "1.2.0", latest_runner_version: null, update_status: "update_available" });
      expect(instance.setRunnerVersionPolicy("versioned-runner", { update_channel: "pinned" }, now + 3)).toBeUndefined();
      expect(instance.setRunnerVersionPolicy("versioned-runner", { update_channel: "stable", latest_runner_version: "latest" }, now + 4)).toBeUndefined();
    });
  });
  it("migrates display names, distinguishes revoke from delete, and cleans selected clients", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`runner-registry-${crypto.randomUUID()}`)); const now = Date.now();
    await runInDurableObject(registry, (instance) => {
      instance.registerRunner("legacy-runner", "a".repeat(64), now);
      expect(instance.getRunner("legacy-runner")).toMatchObject({ runner_id: "legacy-runner", display_name: "legacy-runner" });
      expect(instance.renameRunner("legacy-runner", "Friendly runner", now + 1)).toMatchObject({ runner_id: "legacy-runner", display_name: "Friendly runner" });
      expect(instance.createMcpClient({ client_id: "client-cleanup", label: "Cleanup", secret_verifier: "b".repeat(64), secret_prefix: "prefix-b", scopes: ["coding:read"] }, now)).toBeDefined();
      expect(instance.selectMcpClientRunner("client-cleanup", "legacy-runner", false, now + 2)).toMatchObject({ ok: true });
      instance.revokeRunner("legacy-runner", "legacy-runner", now + 3);
      expect(instance.getMcpClientActiveRunner("client-cleanup")).toMatchObject({ active_runner_id: "legacy-runner", runner: { available: false } });
      // Re-enrollment/rotation retains the selection rather than silently routing
      // a client to another runner.
      instance.registerRunner("legacy-runner", "d".repeat(64), now + 3);
      expect(instance.getMcpClientActiveRunner("client-cleanup")).toMatchObject({ active_runner_id: "legacy-runner" });
      expect(instance.deleteRunner("legacy-runner", "legacy-runner", now + 4)).toBe(true);
      expect(instance.getMcpClientActiveRunner("client-cleanup")).toMatchObject({ active_runner_id: null, runner: null });
    });
  });

  it("updates client scopes without rotating or reviving credentials", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`client-scopes-${crypto.randomUUID()}`)); const now = Date.now();
    await runInDurableObject(registry, async (instance) => {
      const verifier = await sha256Hex("scope-client-secret");
      expect(instance.createMcpClient({ client_id: "scope-client", label: "Scopes", secret_verifier: verifier, secret_prefix: "scope", scopes: ["coding:read"] }, now)).toMatchObject({ secret_version: 1, scopes: ["coding:read"] });
      expect(instance.updateMcpClientScopes("scope-client", ["coding:read", "coding:write"], now + 1)).toMatchObject({ secret_version: 1, revoked_at_ms: null, scopes: ["coding:read", "coding:write"] });
      expect(instance.verifyMcpClient(verifier, now + 2)).toMatchObject({ scopes: ["coding:read", "coding:write"], secret_version: 1 });
      expect(instance.revokeMcpClient("scope-client", now + 3)).toBeDefined();
      expect(instance.updateMcpClientScopes("scope-client", ["coding:read"], now + 4)).toMatchObject({ secret_version: 1, revoked_at_ms: expect.any(Number) });
      expect(instance.verifyMcpClient(verifier, now + 5)).toBeUndefined();
      expect(instance.updateMcpClientScopes("scope-client", [], now + 6)).toBeUndefined();
      expect(instance.updateMcpClientScopes("scope-client", ["coding:read", "coding:read"], now + 7)).toBeUndefined();
      expect(instance.updateMcpClientScopes("missing-client", ["coding:read"], now + 8)).toBeUndefined();
    });
  });

  it("keeps hosted distribution fail-closed unless the exact fixed release acknowledgement is set", async () => {
    const release = runnerReleaseDescriptor({ RUNMESH_SIGNED_RELEASE_AVAILABLE: "not-a-version" });
    expect(release).toMatchObject({ channel: "dev", distributable: false, current_version: "", package_name: "", package_spec: "", artifact: null, manifest_url: null, release_key_id: null });
    const enabled = runnerReleaseDescriptor({ RUNMESH_SIGNED_RELEASE_AVAILABLE: FIXED_RELEASE_VERSION });
    expect(enabled).toMatchObject({ channel: "dev", distributable: true, current_version: FIXED_RELEASE_VERSION, latest_version: FIXED_RELEASE_VERSION, package_spec: FIXED_ARTIFACT_URL, release_key_id: FIXED_RELEASE_KEY_ID });
  });

  it("deletes the migration marker so a recreated Runner starts a fresh lifecycle", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`runner-marker-delete-${crypto.randomUUID()}`)); const now = Date.now();
    await runInDurableObject(registry, (instance, state) => {
      expect(instance.addRunner("marker-runner", "Marker runner", now)).toBeDefined();
      expect(state.storage.sql.exec("SELECT runner_id FROM runner_policy_migrations WHERE runner_id = ?", "marker-runner").toArray()).toHaveLength(1);
      expect(instance.deleteRunner("marker-runner", "marker-runner", now + 1)).toBe(true);
      expect(state.storage.sql.exec("SELECT runner_id FROM runner_policy_migrations WHERE runner_id = ?", "marker-runner").toArray()).toHaveLength(0);
      expect(instance.addRunner("marker-runner", "Recreated runner", now + 2)).toBeDefined();
      expect(state.storage.sql.exec("SELECT runner_id FROM runner_policy_migrations WHERE runner_id = ?", "marker-runner").toArray()).toHaveLength(1);
    });
  });

  it("redeems enrollment once, rejects expiry/regeneration, and exposes no raw enrollment code", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`runner-enrollment-${crypto.randomUUID()}`)); const now = Date.now();
    const code = randomBase64Url(); const verifier = await sha256Hex(code); const info = { platform: "linux", architecture: "x64", hostname: "runner-host", runner_version: "1.0.0", protocol_version: 1 };
    await runInDurableObject(registry, (instance) => {
      expect(instance.addRunner("enrolled-runner", "Enrollment target", now)).toBeDefined();
      expect(instance.createRunnerEnrollment("enrolled-runner", randomBase64Url(), verifier, now)).toBeDefined();
    });
    const tokenVerifier = "c".repeat(64);
    const results = await Promise.all(Array.from({ length: 8 }, () => runInDurableObject(registry, (instance) => instance.redeemRunnerEnrollment(verifier, tokenVerifier, info, now + 1))));
    expect(results.filter((value) => value !== undefined)).toHaveLength(1);
    expect(await runInDurableObject(registry, (instance) => instance.redeemRunnerEnrollment(verifier, tokenVerifier, info, now + 2))).toBeUndefined();
    const oldCode = randomBase64Url(); const oldVerifier = await sha256Hex(oldCode); const replacement = randomBase64Url(); const replacementVerifier = await sha256Hex(replacement);
    await runInDurableObject(registry, (instance) => {
      expect(instance.createRunnerEnrollment("enrolled-runner", randomBase64Url(), oldVerifier, now + 3)).toBeDefined();
      expect(instance.createRunnerEnrollment("enrolled-runner", randomBase64Url(), replacementVerifier, now + 4)).toBeDefined();
    });
    expect(await runInDurableObject(registry, (instance) => instance.redeemRunnerEnrollment(oldVerifier, tokenVerifier, info, now + 5))).toBeUndefined();
    const expiredCode = randomBase64Url(); const expiredVerifier = await sha256Hex(expiredCode);
    await runInDurableObject(registry, (instance) => expect(instance.createRunnerEnrollment("enrolled-runner", randomBase64Url(), expiredVerifier, now)).toBeDefined());
    expect(await runInDurableObject(registry, (instance) => instance.redeemRunnerEnrollment(expiredVerifier, tokenVerifier, info, now + 30 * 60 * 1_000 + 1))).toBeUndefined();
    expect(await runInDurableObject(registry, (instance) => instance.getRunner("enrolled-runner"))).not.toHaveProperty("token_verifier");
  });

  it("serves public secret-free fixed bootstrap templates while availability remains fail closed", async () => {
    const shell = await SELF.fetch("https://worker.test/runner/install.sh");
    const powershell = await SELF.fetch("https://worker.test/runner/install.ps1");
    const release = await SELF.fetch("https://worker.test/runner/releases/latest");
    expect(shell.headers.get("content-type")).toContain("text/x-shellscript");
    expect(powershell.headers.get("content-type")).toContain("text/plain");
    for (const response of [shell, powershell, release]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    const shellText = await shell.text(); const powershellText = await powershell.text();
    for (const text of [shellText, powershellText]) {
      expect(text).not.toMatch(/ADMIN_TOKEN|MCP_SECRET|CODING_RUNNER_TOKEN|Bearer /i);
      expect(text).toContain("not enabled on this deployment");
      expect(text).not.toMatch(/npm install|--code\s+[A-Za-z0-9_-]{20,}|trust-keyring\.json/i);
    }
    expect(await release.json()).toMatchObject({ channel: "dev", distributable: false, package_name: "", package_spec: "", artifact: null, manifest_url: null, release_key_id: null, protocol: { min_version: 2, max_version: 2 } });
    const stable = await SELF.fetch("https://worker.test/runner/releases/stable");
    expect(stable.status).toBe(200);
    expect(await stable.json()).toMatchObject({ channel: "dev", distributable: false, artifact: null });
  });

  it("renders immutable signed installers with embedded key verification and no code input surface", () => {
    const shell = renderPosixInstaller("https://worker.test"); const powershell = renderPowerShellInstaller("https://worker.test");
    for (const text of [shell, powershell]) {
      expect(text).toContain(FIXED_RELEASE_VERSION); expect(text).toContain(FIXED_RELEASE_KEY_ID); expect(text).toContain(FIXED_RELEASE_PUBLIC_KEY_PEM.trim().replaceAll("\n", "\\n")); expect(text).toContain(FIXED_ARTIFACT_URL);
      expect(text).toContain("manifest.json"); expect(text).toContain("manifest.sig"); expect(text).toContain("manifest.signature.json"); expect(text).toContain("SHA256SUMS"); expect(text).toContain("signature does not verify"); expect(text).toContain("artifact size or SHA-256 mismatch");
      expect(text).toContain("--purge --yes"); expect(text).toContain("runmesh-runner");
      expect(text).not.toMatch(/trust-keyring\.json|@latest|npmjs\.com|--code\s+[A-Za-z0-9_-]{20,}/i);
    }
    expect(shell).toContain("--code-stdin"); expect(shell).toContain("/dev/tty"); expect(shell).toContain("stty -echo"); expect(shell).toContain("npm install --global --ignore-scripts");
    expect(shell).toContain("runmesh-runner"); expect(shell).toContain("current/bin/coding-runner"); expect(shell).toContain('--profile "$PROFILE"');
    expect(powershell).toContain("Read-Host"); expect(powershell).toContain("-AsSecureString"); expect(powershell).toContain("Invoke-WebRequest"); expect(powershell).toContain("npm.cmd install --global --ignore-scripts");
    expect(powershell).toContain("runmesh-runner"); expect(powershell).toContain("ProgramData");
  });

  it("returns enrollment credentials once with no-store headers and never puts a token in admin HTML", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry")); const now = Date.now(); const code = randomBase64Url();
    await runInDurableObject(registry, (instance) => {
      expect(instance.addRunner(`http-enrollment-${crypto.randomUUID()}`, "HTTP enrollment", now)).toBeDefined();
    });
    const runnerId = (await runInDurableObject(registry, (instance) => instance.listRunners())).find((runner) => runner.display_name === "HTTP enrollment")?.runner_id;
    expect(runnerId).toBeDefined();
    await runInDurableObject(registry, async (instance) => {
      expect(instance.createRunnerEnrollment(runnerId as string, randomBase64Url(), await sha256Hex(code), now)).toBeDefined();
    });
    const response = await SELF.fetch("https://worker.test/runner/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enrollment_code: code, runner_public_info: { platform: "linux", architecture: "x64", hostname: "host", runner_version: "1.0", protocol_version: 2 } }) });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer"); expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const body = await response.json() as { token?: string }; expect(body.token).toMatch(/^[a-f0-9]{64}$/);
    const second = await SELF.fetch("https://worker.test/runner/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enrollment_code: code, runner_public_info: { platform: "linux", architecture: "x64", hostname: "host", runner_version: "1.0", protocol_version: 2 } }) });
    expect(second.status).toBe(401);
  });

  it("atomically allows exactly one first setup and rejects expired opaque sessions", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`auth-race-${crypto.randomUUID()}`));
    const verifier = await passwordVerifier("password-for-atomic-setup-test");
    const outcomes = await Promise.all([
      runInDurableObject(registry, (instance) => instance.setupAdmin(verifier, Date.now())),
      runInDurableObject(registry, (instance) => instance.setupAdmin(verifier, Date.now())),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const sessionHash = await sha256Hex(randomBase64Url());
    const csrfHash = await sha256Hex(randomBase64Url());
    await expect(runInDurableObject(registry, (instance) => instance.createAdminSession(sessionHash, csrfHash, Date.now() - 1, Date.now() - 2))).resolves.toBe(true);
    await expect(runInDurableObject(registry, (instance) => instance.verifyAdminSession(sessionHash, Date.now()))).resolves.toBeUndefined();
  });

  it("keeps active runner selection sticky per client, requires switch confirmation, and preserves it across rename and rotation", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`active-runner-${crypto.randomUUID()}`));
    const now = Date.now();
    const clientA = "client-active-a"; const clientB = "client-active-b";
    await runInDurableObject(registry, (instance) => {
      instance.registerRunner("runner-a", "a".repeat(64), now);
      instance.registerRunner("runner-b", "b".repeat(64), now);
      expect(instance.createMcpClient({ client_id: clientA, label: "A", secret_verifier: "c".repeat(64), secret_prefix: "prefix-a", scopes: ["coding:read"] }, now)).toBeDefined();
      expect(instance.createMcpClient({ client_id: clientB, label: "B", secret_verifier: "d".repeat(64), secret_prefix: "prefix-b", scopes: ["coding:read"] }, now)).toBeDefined();
      expect(instance.getMcpClientActiveRunner(clientA)).toMatchObject({ active_runner_id: null, runner: null });
      expect(instance.selectMcpClientRunner(clientA, "runner-a", false, now + 1)).toMatchObject({ ok: true, changed: true, selection: { active_runner_id: "runner-a", active_runner_updated_at_ms: now + 1 } });
      expect(instance.selectMcpClientRunner(clientA, "runner-b", false, now + 2)).toMatchObject({ ok: false, code: "runner_switch_confirmation_required", selection: { active_runner_id: "runner-a" } });
      expect(instance.selectMcpClientRunner(clientA, "runner-b", true, now + 3)).toMatchObject({ ok: true, changed: true, selection: { active_runner_id: "runner-b", active_runner_updated_at_ms: now + 3 } });
      expect(instance.getMcpClientActiveRunner(clientB)).toMatchObject({ active_runner_id: null, runner: null });
      expect(instance.renameMcpClient(clientA, "Renamed A", now + 4)).toMatchObject({ active_runner_id: "runner-b" });
      expect(instance.rotateMcpClient(clientA, "e".repeat(64), "prefix-c", now + 5)).toMatchObject({ active_runner_id: "runner-b" });
      instance.revokeRunner("runner-b", "runner-b", now + 6);
      expect(instance.getMcpClientActiveRunner(clientA)).toMatchObject({ active_runner_id: "runner-b", runner: { runner_id: "runner-b", state: "unavailable", available: false } });
    });
  });

  it("sets up once, authenticates a session, enforces CSRF, and manages independent secret URLs", async () => {
    const initial = await SELF.fetch("https://worker.test/");
    expect(initial.status).toBe(200);
    const setupCsrf = formToken(await initial.text());
    const setupCookie = cookieFrom(initial, "__Host-runmesh_setup_csrf");
    expect(setupCsrf).toBe(setupCookie);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(initial.headers.get("referrer-policy")).toBe("no-referrer");
    expect(initial.headers.get("content-security-policy")).toContain("img-src 'self' data:");
    expect(initial.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const rejectedCsrf = await submit("https://worker.test/setup", { setup_token: setupToken, password, confirm_password: password }, new Map(), false);
    expect(rejectedCsrf.status).toBe(403);

    const rejectedSetup = await submit("https://worker.test/setup", { csrf_token: setupCsrf, password, confirm_password: password }, jar([["__Host-runmesh_setup_csrf", setupCookie]]));
    expect(rejectedSetup.status).toBe(403);

    const wrongSetup = await submit("https://worker.test/setup", { csrf_token: setupCsrf, setup_token: "wrong-setup-token", password, confirm_password: password }, jar([["__Host-runmesh_setup_csrf", setupCookie]]));
    expect(wrongSetup.status).toBe(403);

    const setupRequests = await Promise.all(Array.from({ length: 2 }, () => submit(
      "https://worker.test/setup",
      { csrf_token: setupCsrf, setup_token: setupToken, password, confirm_password: password },
      jar([["__Host-runmesh_setup_csrf", setupCookie]]),
    )));
    expect(setupRequests.filter((response) => response.status === 303)).toHaveLength(1);
    expect(setupRequests.filter((response) => response.status === 409)).toHaveLength(1);
    const setup = setupRequests.find((response) => response.status === 303);
    expect(setup).toBeDefined();
    expect(setup?.headers.get("set-cookie")).not.toContain(setupToken);
    const repeated = await SELF.fetch("https://worker.test/setup", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf_token: setupCsrf, setup_token: setupToken, password, confirm_password: password }) });
    expect([403, 409]).toContain(repeated.status);

    const login = await SELF.fetch("https://worker.test/");
    const loginCsrf = formToken(await login.text());
    const loginCookie = cookieFrom(login, "__Host-runmesh_login_csrf");
    const wrong = await submit("https://worker.test/login", { csrf_token: loginCsrf, password: "wrong-password" }, jar([["__Host-runmesh_login_csrf", loginCookie]]));
    expect(wrong.status).toBe(403);
    const loggedIn = await submit("https://worker.test/login", { csrf_token: loginCsrf, password }, jar([["__Host-runmesh_login_csrf", loginCookie]]));
    expect(loggedIn.status).toBe(303);
    const session = cookieFrom(loggedIn, "__Host-runmesh_admin_session");
    const csrf = cookieFrom(loggedIn, "__Host-runmesh_admin_csrf");
    expect(loggedIn.headers.get("set-cookie")).toContain("HttpOnly");
    expect(loggedIn.headers.get("set-cookie")).toContain("SameSite=Strict");
    const adminJar = jar([["__Host-runmesh_admin_session", session], ["__Host-runmesh_admin_csrf", csrf]]);

    const deniedCreate = await submit("https://worker.test/admin/clients", { label: "denied", scopes: "coding:read" }, adminJar);
    expect(deniedCreate.status).toBe(403);

    const created = await submit("https://worker.test/admin/clients", { csrf_token: csrf, label: "Read only ChatGPT", scopes: "coding:read" }, adminJar);
    expect(created.status).toBe(200);
    const createdHtml = await created.text();
    const secretUrl = oneTimeSecretUrl(createdHtml);
    expect(secretUrl).toMatch(/^https:\/\/worker\.test\/[A-Za-z0-9_-]{43}\/mcp$/);
    expect(createdHtml).toContain("will not be shown again");

    const direct = await SELF.fetch("https://worker.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toolsList()) });
    expect(direct.status).toBe(404);
    const wrongSecret = await SELF.fetch("https://worker.test/not-a-valid-secret/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toolsList()) });
    expect(wrongSecret.status).toBe(404);

    const list = await mcp(secretUrl, toolsList());
    expect(list.status).toBe(200);
    const listBody = await readMcp(list) as { result?: { tools?: { name: string }[] } };
    expect(listBody.result?.tools?.map((tool) => tool.name).sort()).toEqual(["edit", "inspect", "job", "read", "runner_current", "runner_list", "runner_select", "shell", "workspace_list"].sort());
    const readOnlyShell = await mcp(secretUrl, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "shell", arguments: { workspace_id: "workspace", command: "echo ignored" } } });
    const readOnlyBody = await readMcp(readOnlyShell) as { result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } } };
    expect(readOnlyBody.result).toMatchObject({ isError: true, structuredContent: { error: { code: "insufficient_scope" } } });
    const legacy = await mcp(secretUrl, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fs_read", arguments: { workspace_id: "workspace", path: "note.txt" } } });
    expect((await readMcp(legacy) as { error?: { code?: number } }).error?.code).toBe(-32602);

    const dashboard = await SELF.fetch("https://worker.test/admin", { headers: { cookie: cookies(adminJar) } });
    const dashboardText = await dashboard.text();
    expect(dashboardText).toContain("Read only ChatGPT");
    expect(dashboardText).not.toContain(new URL(secretUrl).pathname);
    const clientId = /\/admin\/clients\/(client-[a-f0-9]+)\/rename/.exec(dashboardText)?.[1];
    expect(clientId).toBeDefined();
    const scopeUpdate = new URLSearchParams([['csrf_token', csrf], ['scopes', 'coding:read'], ['scopes', 'coding:write']]);
    const scopesResponse = await SELF.fetch(`https://worker.test/admin/clients/${clientId as string}/scopes`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies(adminJar), origin: 'https://worker.test' }, body: scopeUpdate });
    expect(scopesResponse.status).toBe(303);
    const clientsRegistry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
    await expect(runInDurableObject(clientsRegistry, (instance) => instance.listMcpClients().find((client) => client.client_id === clientId))).resolves.toMatchObject({ scopes: ['coding:read', 'coding:write'], secret_version: 1, revoked_at_ms: null });

    const rotated = await submit(`https://worker.test/admin/clients/${clientId as string}/rotate`, { csrf_token: csrf }, adminJar);
    expect(rotated.status).toBe(200);
    const rotatedUrl = oneTimeSecretUrl(await rotated.text());
    expect((await mcp(secretUrl, toolsList())).status).toBe(404);
    expect((await mcp(rotatedUrl, toolsList())).status).toBe(200);

    const revoked = await submit(`https://worker.test/admin/clients/${clientId as string}/revoke`, { csrf_token: csrf }, adminJar);
    expect(revoked.status).toBe(303);
    expect((await mcp(rotatedUrl, toolsList())).status).toBe(404);

    const logout = await submit("https://worker.test/admin/logout", { csrf_token: csrf }, adminJar);
    expect(logout.status).toBe(303);
    expect((await SELF.fetch("https://worker.test/admin", { redirect: "manual", headers: { cookie: cookies(adminJar) } })).status).toBe(303);
  });

  it("applies login throttling through the Worker and recovers after a valid password", async () => {
    const login = await SELF.fetch("https://worker.test/");
    const csrf = formToken(await login.text());
    const csrfCookie = cookieFrom(login, "__Host-runmesh_login_csrf");
    const jarForLogin = jar([["__Host-runmesh_login_csrf", csrfCookie]]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await submit("https://worker.test/login", { csrf_token: csrf, password: `wrong-password-${attempt}` }, jarForLogin);
      expect(failed.status).toBe(403);
    }
    const blocked = await submit("https://worker.test/login", { csrf_token: csrf, password }, jarForLogin);
    expect(blocked.status).toBe(403);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    await runInDurableObject(registry, (instance) => instance.recordAuthAttempt("login", true, Date.now()));
    const recovered = await submit("https://worker.test/login", { csrf_token: csrf, password }, jarForLogin);
    expect(recovered.status).toBe(303);
  });

  it("renders responsive dashboard sections, safe runner data, client routing, and one-time enrollment commands", async () => {
    const logoAsset = await SELF.fetch("https://worker.test/assets/logo.png");
    expect(logoAsset.status).toBe(200);
    expect(logoAsset.headers.get("content-type")).toMatch(/^image\/png/i);
    expect((await logoAsset.arrayBuffer()).byteLength).toBeGreaterThan(1_000);
    const faviconAsset = await SELF.fetch("https://worker.test/assets/favicon.png", { method: "HEAD" });
    expect(faviconAsset.status).toBe(200);
    expect(faviconAsset.headers.get("content-type")).toMatch(/^image\/png/i);
    const loginPage = await SELF.fetch("https://worker.test/");
    const loginHtml = await loginPage.text();
    const logoTag = /<img\b[^>]*\bsrc=["']\/assets\/logo\.png["'][^>]*>/i;
    const logoTagWithAlt = /<img\b(?=[^>]*\bsrc=["']\/assets\/logo\.png["'])(?=[^>]*\balt=["'][^"']+["'])[^>]*>/i;
    expect(loginHtml).toMatch(logoTag);
    expect(loginHtml).toMatch(logoTagWithAlt);
    const passwordToggleTags = [...loginHtml.matchAll(/<button\b[^>]*\bpwd-toggle-btn\b[^>]*>/gi)].map((match) => match[0]);
    expect(passwordToggleTags.length).toBeGreaterThan(0);
    expect(passwordToggleTags.every((tag) => !/\btabindex\s*=\s*["']-1["']/i.test(tag))).toBe(true);
    expect(loginHtml).toContain('M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z');
    expect(loginHtml).not.toContain('M1 12s4-8 11-8 11 8 11 8-11 8-11 8-11-8-11-8z');
    const loginCsrf = formToken(loginHtml);
    const loginCookie = cookieFrom(loginPage, "__Host-runmesh_login_csrf");
    const loggedIn = await submit("https://worker.test/login", { csrf_token: loginCsrf, password }, jar([["__Host-runmesh_login_csrf", loginCookie]]));
    const csrf = cookieFrom(loggedIn, "__Host-runmesh_admin_csrf");
    const adminJar = jar([["__Host-runmesh_admin_session", cookieFrom(loggedIn, "__Host-runmesh_admin_session")], ["__Host-runmesh_admin_csrf", csrf]]);
    const created = await submit("https://worker.test/admin/runners", { csrf_token: csrf, display_name: "Safe runner", runner_id: "dashboard-runner" }, adminJar);
    expect(created.status).toBe(200);
    const enrollment = await created.text();
    expect(enrollment).toContain('class="enrollment-header"');
    expect(enrollment).toMatch(logoTag);
    expect(enrollment).toContain('class="enrollment-brand-logo"');
    expect(enrollment).toContain("Linux"); expect(enrollment).toContain("macOS"); expect(enrollment).toContain("Windows");
    expect(enrollment).toContain("Manual portable-artifact enrollment"); expect(enrollment).toContain("coding-runner enroll"); expect(enrollment).toContain("--code-stdin"); expect(enrollment).toContain("coding-runner install"); expect(enrollment).not.toContain("curl --fail --location"); expect(enrollment).not.toContain("Invoke-WebRequest");
    expect(enrollment).toContain("data-copy"); expect(enrollment).toContain("expires in 30 minutes");
    expect(enrollment).toContain("One-time enrollment code");
    const enrollmentUiText = parseUiTextMap(enrollment);
    expect(enrollmentUiText["Enroll Runner"]).toBe("注册 Runner");
    expect(enrollmentUiText["Target Runner ID"]).toBe("目标 Runner ID");
    expect(enrollmentUiText["One-time enrollment code"]).toBe("一次性注册代码");
    expect(enrollmentUiText["Signed fixed-preview enrollment"]).toBe("签名固定预览版注册");
    expect(enrollmentUiText["Copy installer command"]).toBe("复制安装器命令");
    expect(enrollmentUiText["Paste it only into the local prompt after verification; it is deliberately excluded from copied commands."]).toContain("本地提示");
    for (const copied of enrollment.matchAll(/data-copy="([^"]*)"/g)) expect(copied[1]).not.toContain("--code ");
    expect(enrollment).not.toContain("--re-enroll"); expect(enrollment).not.toContain("-ReEnroll");
    expect(enrollment).not.toContain("--runner-id"); expect(enrollment).not.toContain("ADMIN_TOKEN"); expect(enrollment).not.toMatch(/CODING_RUNNER_TOKEN|MCP_SECRET/i);
    const rotatedEnrollment = await submit("https://worker.test/admin/runners/dashboard-runner/rotate", { csrf_token: csrf }, adminJar);
    expect(rotatedEnrollment.status).toBe(200);
    const rotatedText = await rotatedEnrollment.text();
    expect(rotatedText).toContain("Manual portable-artifact enrollment");
    const stablePolicy = await submit("https://worker.test/admin/runners/dashboard-runner/version-policy", { csrf_token: csrf, update_channel: "stable", desired_runner_version: "" }, adminJar);
    expect(stablePolicy.status).toBe(303);
    const clientsRegistry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    await expect(runInDurableObject(clientsRegistry, (instance) => instance.getRunner("dashboard-runner"))).resolves.toMatchObject({ update_channel: "stable", latest_runner_version: null, update_status: "unknown" });
    const pinned = await submit("https://worker.test/admin/runners/dashboard-runner/version-policy", { csrf_token: csrf, update_channel: "pinned", desired_runner_version: "1.2.0" }, adminJar);
    expect(pinned.status).toBe(303);
    const runnerDetail = await SELF.fetch("https://worker.test/admin/runners/dashboard-runner", { headers: { cookie: cookies(adminJar) } });
    expect(runnerDetail.status).toBe(200);
    const runnerDetailHtml = await runnerDetail.text();
    expect(runnerDetailHtml).toContain("Version policy"); expect(runnerDetailHtml).toContain("Stable/latest version"); expect(runnerDetailHtml).toContain("value=\"1.2.0\""); expect(runnerDetailHtml).toContain("Pinned");
    expect(runnerDetailHtml).toContain("<!doctype html>"); expect(runnerDetailHtml).toContain('<meta name="color-scheme" content="light dark">'); expect(runnerDetailHtml).toContain('class="app-header"'); expect(runnerDetailHtml).toContain('class="active" aria-current="page" href="/admin/runners"'); expect(runnerDetailHtml).toContain('data-theme-toggle'); expect(runnerDetailHtml).toContain("localStorage.getItem('runmesh-theme')"); expect(runnerDetailHtml).toContain(':root[data-theme="dark"]'); expect(runnerDetailHtml).not.toContain("token_verifier");
    expect(runnerDetailHtml).toMatch(logoTag); expect(runnerDetailHtml).toMatch(logoTagWithAlt);
    const dashboard = await SELF.fetch("https://worker.test/admin", { headers: { cookie: cookies(adminJar) } });
    expect(dashboard.headers.get("cache-control")).toBe("no-store");
    expect(dashboard.headers.get("content-security-policy")).toContain("script-src 'unsafe-inline'");
    const dashboardHtml = await dashboard.text();
    for (const section of ["Dashboard", "MCP Clients", "Runners", "Settings", "Active MCP clients", "Online / total runners", "Running jobs", "Recent jobs", "Add Runner", "Add MCP Client"]) expect(dashboardHtml).toContain(section);
    expect(dashboardHtml).toContain('"Clients":"MCP 客户端"');
    expect(dashboardHtml).toMatch(logoTag); expect(dashboardHtml).toMatch(logoTagWithAlt);
    expect(dashboardHtml).toContain('data-lang-toggle="zh-CN"'); expect(dashboardHtml).toContain("var ZH_UI_TEXT="); expect(dashboardHtml).toContain("智能体控制平面"); expect(dashboardHtml).toContain("translateTextNodes"); expect(dashboardHtml).toContain("runmesh_lang");
    expect(dashboardHtml).toContain("@media(max-width:800px)"); expect(dashboardHtml).toContain("navigator.clipboard");
    expect(dashboardHtml).toContain('class="button secondary" href="/admin">Refresh</a>');
    expect(dashboardHtml).not.toContain("data-refresh");
    expect(dashboardHtml).not.toContain("token_verifier"); expect(dashboardHtml).not.toContain("workspace_root");
    const adminScriptText = inlineScriptContaining(dashboardHtml, "function applyLocale");
    const localeOffset = adminScriptText.indexOf("function applyLocale");
    const firstThemeClosure = adminScriptText.indexOf("})();");
    const localeBodyEnd = adminScriptText.indexOf("function requestedLocale", localeOffset);
    const localeBody = adminScriptText.slice(localeOffset, localeBodyEnd < 0 ? undefined : localeBodyEnd);
    const legacyThemeHelpersAreUsed = /\b(?:preference|label)\s*\(/.test(localeBody);
    const themeHelpersRemainInScope = firstThemeClosure < 0 || localeOffset < firstThemeClosure || !legacyThemeHelpersAreUsed || /\b(?:function\s+preference|function\s+label|(?:var|let|const)\s+(?:preference|label))\b/.test(adminScriptText.slice(firstThemeClosure + 4, localeOffset));
    expect(themeHelpersRemainInScope).toBe(true);
    const zhUiText = parseUiTextMap(dashboardHtml);
    expect(zhUiText["MCP Client"]).toBe("MCP 客户端");
    const descriptionTranslations: readonly [string, RegExp][] = [
      ["Inspect workspaces and read files.", /\b(?:Inspect|workspaces|read|files)\b/i],
      ["Apply approved edits.", /\b(?:Apply|approved|edits)\b/i],
      ["Use Host shell and control Jobs.", /\b(?:Use|control|Jobs)\b/i],
    ];
    for (const [source, englishWords] of descriptionTranslations) {
      const translated = zhUiText[source];
      expect(translated, `missing Chinese translation for ${source}`).toBeDefined();
      if (typeof translated === "string") expect(translated).not.toMatch(englishWords);
    }
    for (const mixed of ["Inspect workspaces and 读取 files.", "Apply approved 编辑s.", "Use Host shell and control 任务s.", "Use Host shell and 控制 Jobs."]) expect(dashboardHtml).not.toContain(mixed);
    const clientId = /\/admin\/clients\/(client-[a-f0-9]+)\/rename/.exec(dashboardHtml)?.[1];
    expect(clientId).toBeDefined();
    const scopesDetail = await SELF.fetch(`https://worker.test/admin/clients/${clientId as string}/scopes/detail`, { headers: { cookie: cookies(adminJar) } });
    expect(scopesDetail.status).toBe(200);
    const scopesDetailHtml = await scopesDetail.text();
    expect(scopesDetailHtml).toContain("<!doctype html>"); expect(scopesDetailHtml).toContain('class="app-header"'); expect(scopesDetailHtml).toContain('class="active" aria-current="page" href="/admin/clients"'); expect(scopesDetailHtml).toContain("Base scopes"); expect(scopesDetailHtml).toContain("Each base scope has a distinct ceiling"); expect(scopesDetailHtml).toContain('data-theme-toggle'); expect(scopesDetailHtml).toContain('name="csrf_token"');
    expect(scopesDetailHtml).toMatch(logoTag); expect(scopesDetailHtml).toMatch(logoTagWithAlt);
    const detailScopeFormClass = /<form\b[^>]*class=["']([^"']*\bscope-editor-form\b[^"']*)["'][^>]*>/i.exec(scopesDetailHtml)?.[1] ?? "";
    const detailStyles = /<style>([\s\S]*?)<\/style>/i.exec(scopesDetailHtml)?.[1] ?? "";
    const normalizedStyles = detailStyles.replace(/\s+/g, " ");
    const formGridRuleOffset = normalizedStyles.indexOf(".form-grid{");
    const scopeFlexRuleAfterGrid = formGridRuleOffset >= 0 && /\.scope-editor-form\s*\{[^}]*display\s*:\s*flex\b/.test(normalizedStyles.slice(formGridRuleOffset));
    expect(!/\bform-grid\b/.test(detailScopeFormClass) || scopeFlexRuleAfterGrid).toBe(true);
    expect(normalizedStyles).toMatch(/\.table-wrap\s*\{[^}]*overflow-x\s*:\s*auto/);
    expect(normalizedStyles).toMatch(/@media\s*\(max-width\s*:\s*800px\)/);
    expect(normalizedStyles).toMatch(/@media\s*\(max-width\s*:\s*540px\)/);
    expect(normalizedStyles).toMatch(/\.scope-editor-form\s*\{[^}]*grid-template-columns\s*:\s*1fr/);
    expect(normalizedStyles).toMatch(/\.enrollment-dialog\s+pre\s*\{[^}]*white-space\s*:\s*pre-wrap/);
    expect(normalizedStyles).toMatch(/@media\s*\(max-width\s*:\s*1000px\)\s*and\s*\(min-width\s*:\s*801px\)/);
    expect(normalizedStyles).toMatch(/\.header-actions\s*\{[^}]*overflow-x\s*:\s*auto/);
    expect(normalizedStyles).toMatch(/@media\s*\(max-width\s*:\s*800px\)[\s\S]*?\.header-actions\s*\{[^}]*flex-wrap\s*:\s*wrap[^}]*overflow\s*:\s*visible/);
    expect(normalizedStyles).toMatch(/@media\s*\(max-width\s*:\s*540px\)[\s\S]*?\.header-left\s*\{[^}]*flex-wrap\s*:\s*wrap/);
    expect(normalizedStyles).toMatch(/\.header-left\s+\.control-nav\s*\{[^}]*width\s*:\s*100%[^}]*overflow-x\s*:\s*visible/);
    expect(normalizedStyles).not.toMatch(/@media\s*\(max-width\s*:\s*540px\)[\s\S]*?\.action-btn-group\s*\{[^}]*flex-direction\s*:\s*column/);
    expect(normalizedStyles).toMatch(/@media\s*\(max-width\s*:\s*540px\)[\s\S]*?\.action-btn-group\s*\{[^}]*flex-wrap\s*:\s*nowrap/);
    const rejectedScopesDetailPost = await SELF.fetch(`https://worker.test/admin/clients/${clientId as string}/scopes/detail`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies(adminJar), origin: "https://worker.test" }, body: new URLSearchParams([["csrf_token", csrf], ["scopes", "coding:read"]]) });
    expect(rejectedScopesDetailPost.status).toBe(404);
    await expect(runInDurableObject(clientsRegistry, (instance) => instance.listMcpClients().find((client) => client.client_id === clientId))).resolves.toMatchObject({ scopes: ["coding:read", "coding:write"] });
    await expect(runInDurableObject(clientsRegistry, (instance) => instance.redeemRunnerEnrollment(
      "f".repeat(64),
      "e".repeat(64),
      { platform: "<img src=x onerror=alert(1)>", architecture: "x64", hostname: "host", runner_version: "test", protocol_version: 1 },
      Date.now(),
    ))).resolves.toBeUndefined();
    expect(dashboardHtml).not.toContain("<img src=x onerror=alert(1)>");
    const clients = await SELF.fetch("https://worker.test/admin/clients", { headers: { cookie: cookies(adminJar) } });
    expect(await clients.text()).toContain("Reset Runner Selection");
  });

  it("invalidates every old session after password change", async () => {
    const loginPage = await SELF.fetch("https://worker.test/");
    const loginCsrf = formToken(await loginPage.text());
    const loginCookie = cookieFrom(loginPage, "__Host-runmesh_login_csrf");
    const loggedIn = await submit("https://worker.test/login", { csrf_token: loginCsrf, password }, jar([["__Host-runmesh_login_csrf", loginCookie]]));
    const session = cookieFrom(loggedIn, "__Host-runmesh_admin_session"); const csrf = cookieFrom(loggedIn, "__Host-runmesh_admin_csrf");
    const sessionJar = jar([["__Host-runmesh_admin_session", session], ["__Host-runmesh_admin_csrf", csrf]]);
    const changed = await submit("https://worker.test/admin/password", { csrf_token: csrf, current_password: password, password: "changed-administrator-password", confirm_password: "changed-administrator-password" }, sessionJar);
    expect(changed.status).toBe(303);
    expect((await SELF.fetch("https://worker.test/admin", { redirect: "manual", headers: { cookie: cookies(sessionJar) } })).status).toBe(303);

    const nextLogin = await SELF.fetch("https://worker.test/");
    const nextCsrf = formToken(await nextLogin.text()); const nextCookie = cookieFrom(nextLogin, "__Host-runmesh_login_csrf");
    const oldLogin = await submit("https://worker.test/login", { csrf_token: nextCsrf, password }, jar([["__Host-runmesh_login_csrf", nextCookie]]));
    expect(oldLogin.status).toBe(403);
    const fresh = await SELF.fetch("https://worker.test/");
    const freshCsrf = formToken(await fresh.text()); const freshCookie = cookieFrom(fresh, "__Host-runmesh_login_csrf");
    const newLogin = await submit("https://worker.test/login", { csrf_token: freshCsrf, password: "changed-administrator-password" }, jar([["__Host-runmesh_login_csrf", freshCookie]]));
    expect(newLogin.status).toBe(303);
  });
});

function toolsList(): Record<string, unknown> { return { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }; }
async function mcp(url: string, body: unknown): Promise<Response> { return SELF.fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer deliberately-ignored" }, body: JSON.stringify(body) }); }
async function readMcp(response: Response): Promise<unknown> { const text = await response.text(); if (!response.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text) as unknown; const data = text.split("\n").find((line) => line.trimStart().startsWith("data:"))?.trimStart().slice(5).trim(); return data === undefined ? undefined : JSON.parse(data) as unknown; }
function formToken(html: string): string { const token = /name="csrf_token" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1]; if (token === undefined) throw new Error("csrf token absent"); return token; }
function oneTimeSecretUrl(html: string): string { const url = /<code>(https:\/\/worker\.test\/[A-Za-z0-9_-]{43}\/mcp)<\/code>/.exec(html)?.[1]; if (url === undefined) throw new Error("secret URL absent"); return url; }
function inlineScriptContaining(html: string, marker: string): string {
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1] ?? "").find((value) => value.includes(marker));
  if (script === undefined) throw new Error(`inline script marker absent: ${marker}`);
  return script;
}
function parseUiTextMap(html: string): Record<string, string> {
  const script = inlineScriptContaining(html, "var ZH_UI_TEXT=");
  const encoded = /var\s+ZH_UI_TEXT\s*=\s*([\s\S]*?);\s*function\s+\w+/.exec(script)?.[1];
  if (encoded === undefined) throw new Error("Chinese UI text map absent");
  const parsed: unknown = JSON.parse(encoded);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Chinese UI text map is invalid");
  return parsed as Record<string, string>;
}
function cookieFrom(response: Response, name: string): string { const setCookie = response.headers.get("set-cookie") ?? ""; const value = new RegExp(`${name}=([^;]+)`).exec(setCookie)?.[1]; if (value === undefined) throw new Error(`cookie ${name} absent`); return value; }
function jar(entries: readonly (readonly [string, string])[]): CookieJar { return new Map(entries); }
function cookies(values: CookieJar): string { return [...values].map(([name, value]) => `${name}=${value}`).join("; "); }
async function submit(url: string, values: Record<string, string>, valuesJar: CookieJar, origin = true): Promise<Response> { return SELF.fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies(valuesJar), ...(origin ? { origin: "https://worker.test" } : {}) }, body: new URLSearchParams(values) }); }
