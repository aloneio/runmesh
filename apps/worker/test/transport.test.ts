import { env, SELF, runInDurableObject } from "cloudflare:test";
import { WORKER_BRIDGE_TIMEOUT_MS, PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, decodeWireFrame, encodeWireFrame, type WireMessage } from "@aloneio/runmesh-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_CONTROL_HEADER, INTERNAL_SIGNATURE_SKEW_MS, internalHeaders, randomBase64Url, sha256Hex } from "../src/security.js";
import { RegistryDO, RunnerDO } from "../src/index.js";


describe("Worker runner transport", () => {
  const runnerId = "runner-test";
  const token = "0123456789abcdef0123456789abcdef";

  const adminToken = "test-admin-token-0123456789abcdef";

  async function enroll(id = runnerId, runnerToken = token): Promise<Response> {
    return SELF.fetch("https://worker.test/admin/runners", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ runner_id: id, token: runnerToken }),
    });
  }

  beforeEach(async () => {
    const response = await enroll();
    expect(response.status).toBe(200);
  });

  it("reserves a Worker bridge margin above the maximum local Runner operation", () => {
    expect(WORKER_BRIDGE_TIMEOUT_MS).toBe(12_000);
    expect(WORKER_BRIDGE_TIMEOUT_MS).toBeGreaterThan(8_000);
  });

  it("binds internal proofs to versioned request details and consumes nonces once", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    const secret = "test-internal-control-secret-not-for-production";
    const now = Date.now();
    const nonce = "a".repeat(64);
    const path = "/runners?status=online";
    const headers = await internalHeaders(secret, "GET", path, "", { timestamp: now, nonce });
    const valid = await registry.fetch(`https://registry.internal${path}`, { headers });
    expect(valid.status).toBe(200);
    const replay = await registry.fetch(`https://registry.internal${path}`, { headers });
    expect(replay.status).toBe(404);

    const missing = new Headers(await internalHeaders(secret, "GET", "/runners", "", { timestamp: now, nonce: "b".repeat(64) }));
    missing.delete("x-internal-control-version");
    expect((await registry.fetch("https://registry.internal/runners", { headers: missing })).status).toBe(404);

    const pathHeaders = await internalHeaders(secret, "GET", path, "", { timestamp: now, nonce: "c".repeat(64) });
    expect((await registry.fetch("https://registry.internal/runners?status=offline", { headers: pathHeaders })).status).toBe(404);

    const methodHeaders = await internalHeaders(secret, "GET", "/runners", "", { timestamp: now, nonce: "f".repeat(64) });
    expect((await registry.fetch("https://registry.internal/runners", { method: "POST", headers: methodHeaders, body: "" })).status).toBe(404);

    const bodyHeaders = await internalHeaders(secret, "POST", "/auth/throttle/check", "{}", { timestamp: now, nonce: "d".repeat(64) });
    expect((await registry.fetch("https://registry.internal/auth/throttle/check", { method: "POST", headers: bodyHeaders, body: '{\"kind\":\"setup\"}' })).status).toBe(404);

    const expired = await internalHeaders(secret, "GET", "/runners", "", { timestamp: now - INTERNAL_SIGNATURE_SKEW_MS - 1, nonce: "e".repeat(64) });
    expect((await registry.fetch("https://registry.internal/runners", { headers: expired })).status).toBe(404);
    expect(headers[INTERNAL_CONTROL_HEADER]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("requires a RunnerDO mutation fence before replacing an existing credential", async () => {
    const runnerId = `route-fence-${crypto.randomUUID()}`;
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`route-fence-${crypto.randomUUID()}`));
    await runInDurableObject(registry, (instance) => {
      expect(instance.registerRunner(runnerId, "a".repeat(64), Date.now())).toBe(true);
    });
    const body = JSON.stringify({ token_verifier: "b".repeat(64) });
    const path = `/runners/${encodeURIComponent(runnerId)}`;
    const headers = await internalHeaders("test-internal-control-secret-not-for-production", "PUT", path, body);
    const response = await registry.fetch(new Request(`https://registry.internal${path}`, { method: "PUT", headers, body }));
    expect(response.status).toBe(400);
  });

  it("fails closed when the Registry status is unavailable or malformed", async () => {
    const original = RegistryDO.prototype.fetch;
    let mode: "malformed" | "unavailable" | "initialized" = "malformed";
    const spy = vi.spyOn(RegistryDO.prototype, "fetch").mockImplementation(function (this: RegistryDO, request: Request) {
      if (new URL(request.url).pathname === "/auth/status") {
        if (mode === "malformed") return Promise.resolve(new Response("{malformed", { status: 200 }));
        if (mode === "unavailable") return Promise.resolve(new Response("registry unavailable", { status: 502 }));
        return Promise.resolve(Response.json({ initialized: true }));
      }
      return original.call(this, request);
    });
    try {
      await expect(SELF.fetch("https://worker.test/")).resolves.toMatchObject({ status: 503 });
      mode = "unavailable";
      await expect(SELF.fetch("https://worker.test/")).resolves.toMatchObject({ status: 503 });
      mode = "initialized";
      const login = await SELF.fetch("https://worker.test/");
      expect(login.status).toBe(200);
      await expect(login.text()).resolves.toContain("Admin password");
    } finally {
      spy.mockRestore();
    }
    // A healthy, uninitialized Registry still serves setup normally after the
    // injected failure is removed (the initialized case above covers login).
    const healthy = await SELF.fetch("https://worker.test/");
    expect(healthy.status).toBe(200);
  });

  it("reports uncertain deletion when RunnerDO rejects transport cleanup", async () => {
    const id = `delete-transport-${crypto.randomUUID()}`;
    const runnerToken = "abcdef0123456789abcdef0123456789";
    expect((await enroll(id, runnerToken)).status).toBe(200);
    const original = RunnerDO.prototype.fetch;
    const spy = vi.spyOn(RunnerDO.prototype, "fetch").mockImplementation(function (this: RunnerDO, request: Request) {
      if (new URL(request.url).pathname === "/delete") return Promise.resolve(new Response("simulated failure", { status: 503 }));
      return original.call(this, request);
    });
    try {
      const response = await SELF.fetch(`https://worker.test/admin/runners/${id}/delete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ confirmation: id }),
      });
      expect(response.status).toBe(503);
      await expect(response.text()).resolves.toContain("uncertain");
    } finally {
      spy.mockRestore();
    }
  });

  it("fences a stale pre-hello socket before reusing a deleted runner id", async () => {
    const id = `recreate-${crypto.randomUUID()}`;
    const oldToken = "abcdef0123456789abcdef0123456789";
    const newToken = "0123456789abcdef0123456789abcdef";
    expect((await enroll(id, oldToken)).status).toBe(200);
    const upgrade = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${id}`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${oldToken}` } });
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();

    const original = RunnerDO.prototype.fetch;
    const spy = vi.spyOn(RunnerDO.prototype, "fetch").mockImplementation(function (this: RunnerDO, request: Request) {
      if (new URL(request.url).pathname === "/delete") return Promise.resolve(new Response("simulated cleanup failure", { status: 503 }));
      return original.call(this, request);
    });
    try {
      const deleted = await SELF.fetch(`https://worker.test/admin/runners/${id}/delete`, {
        method: "POST", headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ confirmation: id }),
      });
      expect(deleted.status).toBe(503);
    } finally { spy.mockRestore(); }

    // Registry has no row now, but the old authenticated socket is still held
    // by RunnerDO. A fresh registration must fence and clean that socket before
    // returning the new credential.
    const recreated = await enroll(id, newToken);
    expect(recreated.status).toBe(200);
    const frame = new Promise<WireMessage>((resolve) => socket?.addEventListener("message", (event) => resolve(decodeWireFrame(String(event.data))), { once: true }));
    socket?.send(encodeWireFrame({
      type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "stale-hello", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
      runner: { runner_id: id, runner_version: "old", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
    }));
    await expect(Promise.race([frame, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stale socket received a welcome")), 1_000))])).rejects.toThrow("stale socket received a welcome");
    socket?.close();
  });

  it("allows registration when delete/recreate wins between the pre-fence read and PUT", async () => {
    const id = `register-race-${crypto.randomUUID()}`;
    const oldToken = "abcdef0123456789abcdef0123456789";
    const newToken = "0123456789abcdef0123456789abcdef";
    expect((await enroll(id, oldToken)).status).toBe(200);
    const original = RegistryDO.prototype.fetch;
    let deleted = false;
    const spy = vi.spyOn(RegistryDO.prototype, "fetch").mockImplementation(async function (this: RegistryDO, request: Request) {
      const response = await original.call(this, request);
      const path = new URL(request.url).pathname;
      if (!deleted && request.method === "GET" && path === `/runners/${encodeURIComponent(id)}` && response.ok) {
        deleted = true;
        expect(this.deleteRunner(id, id, Date.now(), `register-race-delete-${crypto.randomUUID()}`)).toBe(true);
      }
      return response;
    });
    try {
      const recreated = await enroll(id, newToken);
      expect(recreated.status).toBe(200);
      expect(deleted).toBe(true);
      const auth = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${id}`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${newToken}` } });
      expect(auth.status).toBe(101);
      auth.webSocket?.accept();
      auth.webSocket?.close();
      const stale = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${id}`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${oldToken}` } });
      expect(stale.status).toBe(401);
    } finally { spy.mockRestore(); }
  });

  it("finalizes registration across a delete/recreate lifecycle while fencing the old connected socket", async () => {
    const id = `register-lifecycle-race-${crypto.randomUUID()}`;
    const oldToken = "abcdef0123456789abcdef0123456789";
    const newToken = "0123456789abcdef0123456789abcdef";
    expect((await enroll(id, oldToken)).status).toBe(200);

    const upgrade = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${id}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${oldToken}` },
    });
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const welcome = new Promise<void>((resolve) => socket?.addEventListener("message", () => resolve(), { once: true }));
    socket?.send(encodeWireFrame({
      type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "lifecycle-race-hello", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
      runner: { runner_id: id, runner_version: "old", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
    }));
    await welcome;
    const closed = new Promise<void>((resolve) => socket?.addEventListener("close", () => resolve(), { once: true }));

    const original = RegistryDO.prototype.fetch;
    let deleted = false;
    const spy = vi.spyOn(RegistryDO.prototype, "fetch").mockImplementation(async function (this: RegistryDO, request: Request) {
      const response = await original.call(this, request);
      const path = new URL(request.url).pathname;
      if (!deleted && request.method === "GET" && path === `/runners/${encodeURIComponent(id)}` && response.ok) {
        deleted = true;
        // Leave the old RunnerDO admission bound to its original lifecycle;
        // the subsequent registration must prove the new marker before its
        // allow_lifecycle_change finalizer can close this socket.
        expect(this.deleteRunner(id, id, Date.now(), `register-lifecycle-delete-${crypto.randomUUID()}`)).toBe(true);
      }
      return response;
    });
    try {
      const recreated = await enroll(id, newToken);
      expect(recreated.status).toBe(200);
      expect(deleted).toBe(true);
      await expect(Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("old lifecycle socket was not fenced")), 1_000))])).resolves.toBeUndefined();
      const auth = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${id}`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${newToken}` } });
      expect(auth.status).toBe(101);
      auth.webSocket?.accept();
      auth.webSocket?.close();
      const stale = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${id}`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${oldToken}` } });
      expect(stale.status).toBe(401);
    } finally { spy.mockRestore(); socket?.close(); }
  });

  it("does not return an enrollment credential when RunnerDO revoke cleanup is uncertain", async () => {
    const id = `enroll-revoke-${crypto.randomUUID()}`;
    const code = randomBase64Url();
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    const now = Date.now();
    await runInDurableObject(registry, async (instance) => {
      expect(instance.addRunner(id, "Enrollment revoke cleanup", now)).toBeDefined();
      expect(instance.createRunnerEnrollment(id, randomBase64Url(), await sha256Hex(code), now)).toBeDefined();
    });
    const original = RunnerDO.prototype.fetch;
    const spy = vi.spyOn(RunnerDO.prototype, "fetch").mockImplementation(function (this: RunnerDO, request: Request) {
      if (new URL(request.url).pathname === "/revoke") return Promise.resolve(new Response("simulated revoke failure", { status: 503 }));
      return original.call(this, request);
    });
    try {
      const response = await SELF.fetch("https://worker.test/runner/enroll", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enrollment_code: code, runner_public_info: { platform: "linux", architecture: "x64", hostname: "host", runner_version: "1.0", protocol_version: 2 } }),
      });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('"token"');
    } finally { spy.mockRestore(); }
  });

  it("rejects credential mutation replays whose token verifier differs", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`credential-replay-${crypto.randomUUID()}`));
    const runnerId = `credential-replay-${crypto.randomUUID()}`;
    const mutationId = `credential-replay-${crypto.randomUUID()}`;
    const now = Date.now();
    await runInDurableObject(registry, (instance, state) => {
      expect(instance.addRunner(runnerId, "Credential replay", now)).toBeDefined();
      expect(instance.registerRunner(runnerId, "a".repeat(64), now + 1, mutationId)).toBe(true);
      expect(instance.registerRunner(runnerId, "b".repeat(64), now + 2, mutationId)).toBe(false);
      expect(state.storage.sql.exec<{ token_verifier: string }>("SELECT token_verifier FROM runners WHERE runner_id = ?", runnerId).toArray()[0]?.token_verifier).toBe("a".repeat(64));
      expect(instance.registerRunner(runnerId, "c".repeat(64), now + 3, `credential-replay-next-${crypto.randomUUID()}`)).toBe(true);
    });
    await expect(runInDurableObject(registry, (instance) => instance.getRunnerMutationState(runnerId, mutationId))).resolves.toMatchObject({ mutation_committed: false, credential_version: 2 });
  });

  it("rejects enrollment mutation replays whose token verifier differs", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`enrollment-replay-${crypto.randomUUID()}`));
    const runnerId = `enrollment-replay-${crypto.randomUUID()}`;
    const code = randomBase64Url(); const verifier = await sha256Hex(code);
    const mutationId = `enrollment-replay-${crypto.randomUUID()}`;
    const info = { platform: "linux", architecture: "x64", hostname: "host", runner_version: "1.0.0", protocol_version: 2 };
    const now = Date.now();
    await runInDurableObject(registry, async (instance) => {
      expect(instance.addRunner(runnerId, "Enrollment replay", now)).toBeDefined();
      expect(instance.createRunnerEnrollment(runnerId, randomBase64Url(), verifier, now)).toBeDefined();
      await expect(instance.redeemRunnerEnrollment(verifier, "a".repeat(64), info, now + 1, mutationId)).resolves.toEqual({ runner_id: runnerId });
    });
    await expect(runInDurableObject(registry, (instance) => instance.redeemRunnerEnrollment(verifier, "b".repeat(64), info, now + 2, mutationId))).resolves.toBeUndefined();
  });

  it("does not keep a runner_create marker committed after enrollment advances credentials", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`runner-create-marker-${crypto.randomUUID()}`));
    const runnerId = `runner-create-marker-${crypto.randomUUID()}`;
    const createMutation = `runner-create-${crypto.randomUUID()}`;
    const code = randomBase64Url();
    const verifier = await sha256Hex(code);
    const now = Date.now();
    const info = { platform: "linux", architecture: "x64", hostname: "host", runner_version: "1.0.0", protocol_version: 2 };
    await runInDurableObject(registry, async (instance) => {
      expect(instance.addRunner(runnerId, "Create marker", now, createMutation)).toBeDefined();
      expect(instance.getRunnerMutationState(runnerId, createMutation)).toMatchObject({ mutation_committed: true, credential_version: 0 });
      expect(instance.createRunnerEnrollment(runnerId, randomBase64Url(), verifier, now)).toBeDefined();
      await expect(instance.redeemRunnerEnrollment(verifier, "a".repeat(64), info, now + 1, `enrollment-${crypto.randomUUID()}`)).resolves.toEqual({ runner_id: runnerId });
      expect(instance.addRunner(runnerId, "Create marker", now + 2, createMutation)).toBeUndefined();
    });
    await expect(runInDurableObject(registry, (instance) => instance.getRunnerMutationState(runnerId, createMutation))).resolves.toMatchObject({ mutation_committed: false, credential_version: 1 });
  });

  it("does not replay a legacy delete marker after the credential generation advances", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`runner-delete-marker-${crypto.randomUUID()}`));
    const runnerId = `runner-delete-marker-${crypto.randomUUID()}`;
    const deleteMutation = `runner-delete-${crypto.randomUUID()}`;
    const rotateMutation = `credential-rotate-${crypto.randomUUID()}`;
    const now = Date.now();
    await runInDurableObject(registry, (instance, state) => {
      expect(instance.registerRunner(runnerId, "a".repeat(64), now)).toBe(true);
      const row = state.storage.sql.exec<{ lifecycle_id: string; credential_version: number }>("SELECT lifecycle_id, credential_version FROM runners WHERE runner_id = ?", runnerId).toArray()[0];
      expect(row).toBeDefined();
      // Simulate the pre-transaction marker written by older Registry code.
      state.storage.sql.exec(
        "INSERT INTO runner_mutations (runner_id, mutation_id, kind, pre_credential_version, lifecycle_id, committed_at_ms) VALUES (?, ?, 'runner_delete', ?, ?, ?)",
        runnerId, deleteMutation, row?.credential_version, row?.lifecycle_id, now + 1,
      );
      expect(instance.registerRunner(runnerId, "b".repeat(64), now + 2, rotateMutation)).toBe(true);
      expect(instance.deleteRunner(runnerId, runnerId, now + 3, deleteMutation)).toBe(false);
      expect(instance.getRunner(runnerId)).toBeDefined();
    });
  });

  it("rejects direct RegistryDO fetches without its internal proof", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    const response = await registry.fetch(`https://registry.internal/runners/${runnerId}`);
    expect(response.status).toBe(404);
  });

  it("enrolls, upgrades, welcomes, persists sync, and rejects a revoked socket", async () => {
    const upgrade = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${runnerId}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
    });
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const hello: WireMessage = {
      type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello-1", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
      runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
    };
    const welcomePromise = new Promise<string>((resolve) => {
      socket?.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    });
    socket?.send(encodeWireFrame(hello));
    const welcome = await welcomePromise;
    expect(decodeWireFrame(welcome).type).toBe("runner.welcome");
    socket?.send(encodeWireFrame({ type: "runner.sync", protocol_version: PROTOCOL_CURRENT_VERSION, runner_id: runnerId, sync_sequence: 1, sent_at_ms: Date.now(), workspaces: [{ workspace_id: "workspace-1", persistence: "persistent", labels: {} }], jobs: [] }));
    const closePromise = new Promise<void>((resolve) => {
      socket?.addEventListener("close", () => resolve(), { once: true });
    });
    const rotation = await SELF.fetch(`https://worker.test/admin/runners/${runnerId}/rotate`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ token: "abcdef0123456789abcdef0123456789" }) });
    expect(rotation.status).toBe(200);
    await closePromise;
  });

  it("pushes a central policy update to an online Runner and enforces readiness", async () => {
    const upgrade = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${runnerId}`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } });
    const socket = upgrade.webSocket;
    socket?.accept();
    socket?.send(encodeWireFrame({ type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello-policy", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
      runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
    }));
    await new Promise<void>((resolve) => socket?.addEventListener("message", () => resolve(), { once: true }));
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    const mutationId = "policy-push-test";
    const beginBody = JSON.stringify({ mutation_id: mutationId });
    const beginHeaders = await internalHeaders("test-internal-control-secret-not-for-production", "POST", "/begin-policy-mutation", beginBody);
    const object = env.RUNNER.get(env.RUNNER.idFromName(runnerId));
    expect((await object.fetch("https://runner.internal/begin-policy-mutation", { method: "POST", headers: beginHeaders, body: beginBody })).status).toBe(204);
    const policy = { workspace_id: "policy-workspace", display_name: "Policy workspace", root_path: "/tmp", enabled: true, permissions: { read: true, edit: false, shell: false, job_control: false } };
    const created = await runInDurableObject(registry, (instance) => instance.createManagedWorkspace(runnerId, policy, Date.now(), mutationId));
    expect(created).toMatchObject({ workspace_id: policy.workspace_id });
    const pushBody = JSON.stringify({ mutation_id: mutationId });
    const pushHeaders = await internalHeaders("test-internal-control-secret-not-for-production", "POST", "/policy", pushBody);
    const policyUpdate = new Promise<WireMessage>((resolve) => socket?.addEventListener("message", (event) => { const value = decodeWireFrame(String(event.data)); if (value.type === "runner.policy_update") resolve(value); }));
    const push = await object.fetch("https://runner.internal/policy", { method: "POST", headers: pushHeaders, body: pushBody });
    expect(push.status).toBe(204);
    await expect(policyUpdate).resolves.toMatchObject({ type: "runner.policy_update", policy: { revision: expect.any(Number), workspaces: [{ workspace_id: policy.workspace_id }] } });
    const stateHeaders = await internalHeaders("test-internal-control-secret-not-for-production", "GET", "/admission-state", "");
    const admission = await object.fetch("https://runner.internal/admission-state", { method: "GET", headers: stateHeaders });
    expect(admission.status).toBe(200);
    await expect(admission.json()).resolves.toMatchObject({ fenced: true, mutationId });
    const cancelBody = JSON.stringify({ mutation_id: mutationId });
    const cancelHeaders = await internalHeaders("test-internal-control-secret-not-for-production", "POST", "/cancel-policy-mutation", cancelBody);
    const cancelled = await object.fetch("https://runner.internal/cancel-policy-mutation", { method: "POST", headers: cancelHeaders, body: cancelBody });
    expect(cancelled.status).toBe(409);
    socket?.close();
  });
  it("allows committed offline policies to supersede while preserving precommit exclusivity", async () => {
    const object = env.RUNNER.get(env.RUNNER.idFromName(runnerId));
    const secret = "test-internal-control-secret-not-for-production";
    const post = async (path: string, body: Record<string, unknown>): Promise<Response> => {
      const text = JSON.stringify(body);
      const headers = await internalHeaders(secret, "POST", path, text);
      return object.fetch(new Request(`https://runner.internal${path}`, { method: "POST", headers, body: text }));
    };
    const admission = async (): Promise<Record<string, unknown>> => {
      const headers = await internalHeaders(secret, "GET", "/admission-state", "");
      const response = await object.fetch(new Request("https://runner.internal/admission-state", { headers }));
      return response.json() as Promise<Record<string, unknown>>;
    };

    // A newly instantiated, offline RunnerDO is in restart reconciliation. A
    // mutation must be able to replace that fence without restoring admission.
    expect((await post("/begin-policy-mutation", { mutation_id: "restart-offline", runner_id: runnerId })).status).toBe(204);
    await expect(admission()).resolves.toMatchObject({ fenced: true, mutationId: "restart-offline", mutationPhase: "precommit" });
    expect((await post("/begin-policy-mutation", { mutation_id: "precommit-conflict", runner_id: runnerId })).status).toBe(409);

    // An uncommitted offline precommit can be cancelled, but cancellation keeps
    // the live-admission fence closed because no session identity can be restored.
    const cancelled = await post("/cancel-policy-mutation", { mutation_id: "restart-offline" });
    expect(cancelled.status).toBe(204);
    await expect(admission()).resolves.toMatchObject({ fenced: true, mutationId: null, mutationPhase: "idle" });

    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    expect((await post("/begin-policy-mutation", { mutation_id: "offline-first", runner_id: runnerId })).status).toBe(204);
    const offlineFirst = await runInDurableObject(registry, (instance) => ({
      workspace: instance.createManagedWorkspace(runnerId, {
        workspace_id: "offline-one", display_name: "Offline one", root_path: "/tmp", enabled: true,
        permissions: { read: true, edit: false, shell: false, job_control: false },
      }, Date.now(), "offline-first"),
    }));
    expect(offlineFirst.workspace).toBeDefined();
    const firstDesired = await runInDurableObject(registry, (instance) => instance.getDesiredPolicySnapshot(runnerId));
    expect(firstDesired).toBeDefined();
    expect((await post("/mark-policy-committed", { mutation_id: "offline-first", phase: "offline_pending", desired_revision: firstDesired?.revision, desired_checksum: firstDesired?.checksum })).status).toBe(204);

    // The current desired immutable revision is committed, so the next offline
    // edit supersedes it instead of deadlocking behind an obsolete mutation ID.
    expect((await post("/begin-policy-mutation", { mutation_id: "offline-second", runner_id: runnerId })).status).toBe(204);
    const offlineSecond = await runInDurableObject(registry, (instance) => ({
      workspace: instance.createManagedWorkspace(runnerId, {
        workspace_id: "offline-two", display_name: "Offline two", root_path: "/var/tmp", enabled: true,
        permissions: { read: true, edit: false, shell: false, job_control: false },
      }, Date.now(), "offline-second"),
    }));
    expect(offlineSecond.workspace).toBeDefined();
    const secondDesired = await runInDurableObject(registry, (instance) => instance.getDesiredPolicySnapshot(runnerId));
    expect(secondDesired).toBeDefined();
    expect((await post("/mark-policy-committed", { mutation_id: "offline-second", phase: "offline_pending", desired_revision: secondDesired?.revision, desired_checksum: secondDesired?.checksum })).status).toBe(204);
    await expect(admission()).resolves.toMatchObject({ fenced: true, mutationId: "offline-second", mutationPhase: "offline_pending" });
  });

  it("keeps invalid and stale acknowledgements from replacing the current desired mutation", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName(`policy-supersede-${crypto.randomUUID()}`));
    const now = Date.now();
    await runInDurableObject(registry, (instance) => {
      expect(instance.addRunner("policy-supersede", "Policy supersede", now)).toBeDefined();
      const runner = instance.getRunner("policy-supersede");
      const credentialVersion = runner?.credential_version ?? 0;
      const epoch = instance.beginConnection("policy-supersede", {
        runner_id: "policy-supersede", runner_version: "test", platform: "test", architecture: "test",
        capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} },
      }, { min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION }, "policy-session", credentialVersion, now + 1);
      expect(epoch).toEqual(expect.any(Number));
      const initial = instance.getDesiredPolicySnapshot("policy-supersede");
      expect(initial).toBeDefined();
      expect(instance.acknowledgePolicy("policy-supersede", epoch as number, credentialVersion, {
        desired_revision: initial?.revision as number, desired_checksum: initial?.checksum as string,
        applied_revision: initial?.revision as number, applied_checksum: initial?.checksum as string,
        runner_reported_policy_revision: initial?.revision as number, runner_reported_policy_checksum: initial?.checksum as string,
        status: "applied", workspace_status: [],
      }, now + 2)).toBe("applied");

      expect(instance.createManagedWorkspace("policy-supersede", {
        workspace_id: "invalid-root", display_name: "Invalid root", root_path: "/missing", enabled: true,
        permissions: { read: true, edit: false, shell: false, job_control: false },
      }, now + 3, "invalid-first")).toBeDefined();
      const invalid = instance.getDesiredPolicySnapshot("policy-supersede");
      expect(instance.acknowledgePolicy("policy-supersede", epoch as number, credentialVersion, {
        desired_revision: invalid?.revision as number, desired_checksum: invalid?.checksum as string,
        applied_revision: initial?.revision as number, applied_checksum: initial?.checksum as string,
        runner_reported_policy_revision: initial?.revision as number, runner_reported_policy_checksum: initial?.checksum as string,
        status: "invalid", workspace_status: [{ workspace_id: "invalid-root", status: "missing" }],
      }, now + 4)).toBe("invalid");
      expect(instance.getRunner("policy-supersede")).toMatchObject({ policy_status: "invalid", applied_policy_revision: initial?.revision });

      expect(instance.setRunnerPermissions("policy-supersede", { read: false, edit: false, shell: false, job_control: false }, now + 5, "invalid-second")).toBeDefined();
      expect(instance.getRunnerMutationState("policy-supersede", "invalid-first").mutation_committed).toBe(false);
      expect(instance.getRunnerMutationState("policy-supersede", "invalid-second").mutation_committed).toBe(true);
      // A delayed ACK for the invalid policy is recognized as stale and cannot
      // overwrite the new desired identity or its mutation ownership.
      expect(instance.acknowledgePolicy("policy-supersede", epoch as number, credentialVersion, {
        desired_revision: invalid?.revision as number, desired_checksum: invalid?.checksum as string,
        applied_revision: initial?.revision as number, applied_checksum: initial?.checksum as string,
        runner_reported_policy_revision: initial?.revision as number, runner_reported_policy_checksum: initial?.checksum as string,
        status: "invalid", workspace_status: [{ workspace_id: "invalid-root", status: "missing" }],
      }, now + 6)).toBe("stale");
      expect(instance.getRunner("policy-supersede")).toMatchObject({ policy_status: "pending" });
      expect(instance.getSnapshotAuthorization("policy-supersede")).toMatchObject({ ok: false });
    });
  });
  it("rejects invalid identifiers and invalid authentication", async () => {
    await expect(SELF.fetch("https://worker.test/runner/connect?runner_id=%2Fbad", { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } })).resolves.toMatchObject({ status: 400 });
    await expect(SELF.fetch(`https://worker.test/runner/connect?runner_id=${runnerId}`, { headers: { Upgrade: "websocket", Authorization: "Bearer incorrect-token-0123456789" } })).resolves.toMatchObject({ status: 401 });
  });
  it("serves health without an object invocation", async () => {
    const response = await SELF.fetch("https://worker.test/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("rejects unauthenticated runner upgrades without accepting a query token", async () => {
    const response = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${runnerId}&token=${token}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(401);
  });

  it("keeps the internal RPC bridge private and reports an offline runner", async () => {
    const object = env.RUNNER.get(env.RUNNER.idFromName(runnerId));
    const direct = await object.fetch("https://runner.internal/rpc", { method: "POST", body: JSON.stringify({ method: "workspace.list", params: {} }) });
    expect(direct.status).toBe(404);
    const body = JSON.stringify({ method: "workspace.list", params: {} });
    const headers = await internalHeaders("test-internal-control-secret-not-for-production", "POST", "/rpc", body);
    const offline = await object.fetch("https://runner.internal/rpc", { method: "POST", headers, body });
    expect([502, 503]).toContain(offline.status);
  });
  it("does not expose credential verifiers through runner metadata", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    const output = await runInDurableObject(registry, (instance) => instance.getRunner(runnerId));
    expect(output).not.toHaveProperty("token_verifier");
  });

  it("rejects duplicate and stale sync snapshots", async () => {
    const upgrade = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${runnerId}`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } });
    const socket = upgrade.webSocket;
    socket?.accept();
    socket?.send(encodeWireFrame({ type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello-sync", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
      runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
    }));
    await new Promise<void>((resolve) => socket?.addEventListener("message", () => resolve(), { once: true }));
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    const record = await runInDurableObject(registry, (instance) => instance.getRunner(runnerId));
    const epoch = record?.connection_epoch;
    const credentialVersion = record?.credential_version;
    expect(epoch).toEqual(expect.any(Number));
    expect(credentialVersion).toEqual(expect.any(Number));
    const result = await runInDurableObject(registry, (instance) => ({
      first: instance.syncRunner(runnerId, epoch as number, credentialVersion as number, [], [], 2, Date.now(), false),
      duplicate: instance.syncRunner(runnerId, epoch as number, credentialVersion as number, [], [], 2, Date.now(), false),
      stale: instance.syncRunner(runnerId, epoch as number, credentialVersion as number, [], [], 1, Date.now(), false),
    }));
    expect(result).toEqual({ first: true, duplicate: false, stale: false });
    socket?.close();
  });

  it("persists validated job lifecycle events immediately", async () => {
    const upgrade = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${runnerId}`, { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } });
    const socket = upgrade.webSocket;
    socket?.accept();
    socket?.send(encodeWireFrame({ type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello-events", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
      runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
    }));
    await new Promise<void>((resolve) => socket?.addEventListener("message", () => resolve(), { once: true }));
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    const record = await runInDurableObject(registry, (instance) => instance.getRunner(runnerId));
    const epoch = record?.connection_epoch;
    const credentialVersion = record?.credential_version;
    const recorded = await runInDurableObject(registry, (instance) => instance.recordJobEvent(runnerId, epoch as number, credentialVersion as number, {
      type: "job.status", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "job-event-1",
      job: { job_id: "job-event-1", workspace_id: "workspace-1", status: "running", created_at_ms: 1, updated_at_ms: 2, runner_id: runnerId },
    }, Date.now(), false));
    expect(recorded).toBe(true);
    await expect(runInDurableObject(registry, (instance) => instance.listJobs(runnerId))).resolves.toMatchObject([{ job_id: "job-event-1", status: "running" }]);
    socket?.close();
  });

  it("retains historical jobs across bounded sync snapshots, filters before limit, and preserves active jobs during terminal retention", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    const initial = await runInDurableObject(registry, (instance) => instance.getRunner(runnerId));
    const epoch = initial?.connection_epoch as number;
    const credentialVersion = initial?.credential_version as number;
    const now = Date.now();
    const terminal = Array.from({ length: 1_005 }, (_, index) => ({
      job_id: `terminal-${String(index).padStart(4, "0")}`,
      workspace_id: index % 2 === 0 ? "workspace-a" : "workspace-b",
      status: "succeeded" as const,
      created_at_ms: now - index,
      updated_at_ms: now - index,
      runner_id: runnerId,
    }));
    const active = { job_id: "active-old", workspace_id: "workspace-a", status: "running" as const, created_at_ms: 1, updated_at_ms: 1, runner_id: runnerId };
    await runInDurableObject(registry, (instance) => {
      expect(instance.syncRunner(runnerId, epoch, credentialVersion, [], [...terminal, active], 1, now, false)).toBe(true);
      expect(instance.syncRunner(runnerId, epoch, credentialVersion, [], [], 2, now + 1, false)).toBe(true);
    });
    const preserved = await runInDurableObject(registry, (instance) => ({
      active: instance.getJob(runnerId, "active-old"),
      filtered: instance.listJobs(runnerId, { workspace_id: "workspace-b", status: "succeeded", limit: 5 }),
      all: instance.listJobs(runnerId, { limit: 100 }),
    }));
    expect(preserved.active).toMatchObject({ job_id: "active-old", status: "running" });
    expect(preserved.filtered).toHaveLength(5);
    expect(preserved.filtered.every((job) => (job as { workspace_id: string; status: string }).workspace_id === "workspace-b" && (job as { status: string }).status === "succeeded")).toBe(true);
    expect(preserved.all.length).toBeLessThanOrEqual(100);
  });

  it("persists registration and initial offline state in SQLite", async () => {
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    const output = await runInDurableObject(registry, (instance) => instance.getRunner(runnerId));
    expect(output).toMatchObject({
      runner_id: runnerId,
      state: "offline",
      connection_epoch: expect.any(Number),
    });
  });
});
