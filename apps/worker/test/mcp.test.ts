import { env, SELF, runInDurableObject } from "cloudflare:test";
import { passwordVerifier, randomBase64Url, sha256Hex, verifySetupToken } from "../src/security.js";
import { runnerReleaseDescriptor } from "../src/index.js";
import { PRODUCT_VERSION } from "../src/generated-version.js";
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

  it("serves public secret-free cached bootstrap scripts and a bounded release descriptor", async () => {
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
      expect(text).not.toMatch(/sudo|git clone|github\.com\/.*main/i);
    }
    expect(shellText).toContain("Hosted unsigned bootstrap is disabled");
    expect(powershellText).toContain("Hosted unsigned bootstrap is disabled");
    expect(await release.json()).toMatchObject({ channel: "stable", distributable: false, package_spec: "", current_version: PRODUCT_VERSION, latest_version: PRODUCT_VERSION, package_version: PRODUCT_VERSION, artifact: null, protocol: { min_version: 2, max_version: 2 } });
    const stable = await SELF.fetch("https://worker.test/runner/releases/stable");
    expect(stable.status).toBe(200);
    expect(await stable.json()).toMatchObject({ channel: "stable", current_version: PRODUCT_VERSION, latest_version: PRODUCT_VERSION, package_version: PRODUCT_VERSION, protocol: { min_version: 2, max_version: 2 } });
    expect(runnerReleaseDescriptor({ RUNNER_PACKAGE_SPEC: "@acme/coding-runner@1.2.3" })).toMatchObject({ distributable: false, package_spec: "" });
    expect(runnerReleaseDescriptor({ RUNNER_PACKAGE_SPEC: "@acme/coding-runner@1.2.3", ALLOW_LEGACY_UNSIGNED_BOOTSTRAP: "true" })).toMatchObject({ channel: "stable", distributable: true, package_name: "@acme/coding-runner", package_version: "1.2.3", package_spec: "@acme/coding-runner@1.2.3", artifact: { source: "@acme/coding-runner@1.2.3" }, protocol: { min_version: 2, max_version: 2 } });
    expect(runnerReleaseDescriptor({ RUNNER_PACKAGE_SPEC: "https://downloads.example.test/runner-1.2.3.tgz", RUNNER_PACKAGE_NAME: "@acme/coding-runner", RUNNER_PACKAGE_VERSION: "1.2.3", ALLOW_LEGACY_UNSIGNED_BOOTSTRAP: "true" })).toMatchObject({ distributable: true, package_version: "1.2.3", artifact: { source: "https://downloads.example.test/runner-1.2.3.tgz" } });
    expect(runnerReleaseDescriptor({ RUNNER_PACKAGE_SPEC: "https://downloads.example.test/runner-1.2.3.tgz", RUNNER_PACKAGE_NAME: "@acme/coding-runner", RUNNER_PACKAGE_VERSION: "1.2.3", RUNNER_ARTIFACT_SHA256: "a".repeat(64), ALLOW_LEGACY_UNSIGNED_BOOTSTRAP: "true" })).toMatchObject({ distributable: true, artifact: { source: "https://downloads.example.test/runner-1.2.3.tgz", checksum: { algorithm: "sha256", value: "a".repeat(64) } } });
    expect(runnerReleaseDescriptor({ RUNNER_PACKAGE_SPEC: "@acme/coding-runner@latest", ALLOW_LEGACY_UNSIGNED_BOOTSTRAP: "true" }).distributable).toBe(false);
    expect(runnerReleaseDescriptor({ RUNNER_PACKAGE_SPEC: "https://downloads.example.test/main/runner.tgz", RUNNER_PACKAGE_NAME: "@acme/coding-runner", RUNNER_PACKAGE_VERSION: "1.2.3", RUNNER_ARTIFACT_SHA256: "a".repeat(64), ALLOW_LEGACY_UNSIGNED_BOOTSTRAP: "true" }).distributable).toBe(false);
    expect(runnerReleaseDescriptor({ RUNNER_PACKAGE_SPEC: "https://github.com/acme/runner/archive/main.tgz", RUNNER_PACKAGE_NAME: "@acme/coding-runner", RUNNER_PACKAGE_VERSION: "1.2.3", RUNNER_ARTIFACT_SHA256: "a".repeat(64), ALLOW_LEGACY_UNSIGNED_BOOTSTRAP: "true" }).distributable).toBe(false);
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
    const loginPage = await SELF.fetch("https://worker.test/");
    const loginCsrf = formToken(await loginPage.text());
    const loginCookie = cookieFrom(loginPage, "__Host-runmesh_login_csrf");
    const loggedIn = await submit("https://worker.test/login", { csrf_token: loginCsrf, password }, jar([["__Host-runmesh_login_csrf", loginCookie]]));
    const csrf = cookieFrom(loggedIn, "__Host-runmesh_admin_csrf");
    const adminJar = jar([["__Host-runmesh_admin_session", cookieFrom(loggedIn, "__Host-runmesh_admin_session")], ["__Host-runmesh_admin_csrf", csrf]]);
    const created = await submit("https://worker.test/admin/runners", { csrf_token: csrf, display_name: "Safe runner", runner_id: "dashboard-runner" }, adminJar);
    expect(created.status).toBe(200);
    const enrollment = await created.text();
    expect(enrollment).toContain("Linux"); expect(enrollment).toContain("macOS"); expect(enrollment).toContain("Windows");
    expect(enrollment).toContain("/runner/install.sh"); expect(enrollment).toContain("/runner/install.ps1"); expect(enrollment).toContain("curl -fsSL"); expect(enrollment).toContain("Invoke-RestMethod");
    expect(enrollment).toContain("data-copy"); expect(enrollment).toContain("expires in 30 minutes");
    expect(enrollment).not.toContain("--re-enroll"); expect(enrollment).not.toContain("-ReEnroll");
    expect(enrollment).not.toContain("--runner-id"); expect(enrollment).not.toContain("ADMIN_TOKEN"); expect(enrollment).not.toMatch(/CODING_RUNNER_TOKEN|MCP_SECRET/i);
    const rotatedEnrollment = await submit("https://worker.test/admin/runners/dashboard-runner/rotate", { csrf_token: csrf }, adminJar);
    expect(rotatedEnrollment.status).toBe(200);
    const rotatedText = await rotatedEnrollment.text();
    expect(rotatedText).toContain("--re-enroll"); expect(rotatedText).toContain("-ReEnroll");
    const pinned = await submit("https://worker.test/admin/runners/dashboard-runner/version-policy", { csrf_token: csrf, update_channel: "pinned", desired_runner_version: "1.2.0" }, adminJar);
    expect(pinned.status).toBe(303);
    const runnerDetail = await SELF.fetch("https://worker.test/admin/runners/dashboard-runner", { headers: { cookie: cookies(adminJar) } });
    expect(runnerDetail.status).toBe(200);
    const runnerDetailHtml = await runnerDetail.text();
    expect(runnerDetailHtml).toContain("Version policy"); expect(runnerDetailHtml).toContain("Stable/latest version"); expect(runnerDetailHtml).toContain("value=\"1.2.0\""); expect(runnerDetailHtml).toContain("Pinned");
    const dashboard = await SELF.fetch("https://worker.test/admin", { headers: { cookie: cookies(adminJar) } });
    expect(dashboard.headers.get("cache-control")).toBe("no-store");
    expect(dashboard.headers.get("content-security-policy")).toContain("script-src 'unsafe-inline'");
    const dashboardHtml = await dashboard.text();
    for (const section of ["Dashboard", "MCP Clients", "Runners", "Settings", "Active MCP clients", "Online / total runners", "Running jobs", "Recent jobs", "Add Runner", "Add MCP Client"]) expect(dashboardHtml).toContain(section);
    expect(dashboardHtml).toContain("@media(max-width:800px)"); expect(dashboardHtml).toContain("navigator.clipboard");
    expect(dashboardHtml).not.toContain("token_verifier"); expect(dashboardHtml).not.toContain("workspace_root");
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    await expect(runInDurableObject(registry, (instance) => instance.redeemRunnerEnrollment(
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
function cookieFrom(response: Response, name: string): string { const setCookie = response.headers.get("set-cookie") ?? ""; const value = new RegExp(`${name}=([^;]+)`).exec(setCookie)?.[1]; if (value === undefined) throw new Error(`cookie ${name} absent`); return value; }
function jar(entries: readonly (readonly [string, string])[]): CookieJar { return new Map(entries); }
function cookies(values: CookieJar): string { return [...values].map(([name, value]) => `${name}=${value}`).join("; "); }
async function submit(url: string, values: Record<string, string>, valuesJar: CookieJar, origin = true): Promise<Response> { return SELF.fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies(valuesJar), ...(origin ? { origin: "https://worker.test" } : {}) }, body: new URLSearchParams(values) }); }
