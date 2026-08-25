import { env, SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { internalHeaders } from "../src/security.js";
import { decodeWireFrame, encodeWireFrame, type WireMessage } from "@remote-coding-runtime/protocol";


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
      type: "runner.hello", protocol_version: 1, request_id: "hello-1", min_protocol_version: 1, max_protocol_version: 1,
      runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
    };
    const welcomePromise = new Promise<string>((resolve) => {
      socket?.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
    });
    socket?.send(encodeWireFrame(hello));
    const welcome = await welcomePromise;
    expect(decodeWireFrame(welcome).type).toBe("runner.welcome");
    socket?.send(encodeWireFrame({ type: "runner.sync", protocol_version: 1, runner_id: runnerId, sync_sequence: 1, sent_at_ms: Date.now(), workspaces: [{ workspace_id: "workspace-1", persistence: "persistent", labels: {} }], jobs: [] }));
    const closePromise = new Promise<void>((resolve) => {
      socket?.addEventListener("close", () => resolve(), { once: true });
    });
    const rotation = await SELF.fetch(`https://worker.test/admin/runners/${runnerId}/rotate`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ token: "abcdef0123456789abcdef0123456789" }) });
    expect(rotation.status).toBe(200);
    await closePromise;
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
    socket?.send(encodeWireFrame({ type: "runner.hello", protocol_version: 1, request_id: "hello-sync", min_protocol_version: 1, max_protocol_version: 1,
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
    socket?.send(encodeWireFrame({ type: "runner.hello", protocol_version: 1, request_id: "hello-events", min_protocol_version: 1, max_protocol_version: 1,
      runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
    }));
    await new Promise<void>((resolve) => socket?.addEventListener("message", () => resolve(), { once: true }));
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
    const record = await runInDurableObject(registry, (instance) => instance.getRunner(runnerId));
    const epoch = record?.connection_epoch;
    const credentialVersion = record?.credential_version;
    const recorded = await runInDurableObject(registry, (instance) => instance.recordJobEvent(runnerId, epoch as number, credentialVersion as number, {
      type: "job.status", protocol_version: 1, request_id: "job-event-1",
      job: { job_id: "job-event-1", workspace_id: "workspace-1", status: "running", created_at_ms: 1, updated_at_ms: 2, runner_id: runnerId },
    }, Date.now(), false));
    expect(recorded).toBe(true);
    await expect(runInDurableObject(registry, (instance) => instance.listJobs(runnerId))).resolves.toMatchObject([{ job_id: "job-event-1", status: "running" }]);
    socket?.close();
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
