import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { RunnerUpdateMaintenance, type MaintenanceConnection } from "../src/platform/runner-update-maintenance.js";
import type { RunnerUpdateOperation } from "@aloneio/runmesh-protocol";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, decodeWireFrame, encodeWireFrame } from "@aloneio/runmesh-protocol";
import { RunnerDO } from "../src/runner-do.js";
import { internalHeaders } from "../src/security.js";

const owner = { runner_id: "upgrade-test", operation_id: "operation-1", lifecycle_id: "a".repeat(64), manager_id: "manager-1", credential_version: 1 };
function operation(): RunnerUpdateOperation {
  return { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id, target_version: "0.1.7-dev.42", target_channel: "dev", manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64), original_version: "0.1.7", manager_id: owner.manager_id, state: "draining", error_code: null, created_at_ms: 1, updated_at_ms: 1 };
}
function fixture(storage: DurableObjectStorage) {
  let current = operation(); let epoch = 4; let pending = 0;
  let connections: MaintenanceConnection[] = [];
  const registry = async () => Response.json({ update: { operation: current, cloud_drained: false, cloud_uncertain: false, observed_version: null, observed_new_session: false }, claim_epoch: 4, connection_epoch: epoch });
  const ports = { storage, registry, connections: () => connections, pendingReplies: () => pending };
  const maintenance = new RunnerUpdateMaintenance(ports);
  return { maintenance, ports, setOperation: (value: RunnerUpdateOperation) => { current = value; }, setEpoch: (value: number) => { epoch = value; }, setPending: (value: number) => { pending = value; }, setConnections: (value: MaintenanceConnection[]) => { connections = value; } };
}
async function call(maintenance: RunnerUpdateMaintenance, action: string, input: Record<string, unknown> = owner) {
  const read = action === "read"; const body = read ? "" : JSON.stringify(input);
  const suffix = read ? `?operation_id=${input.operation_id}&lifecycle_id=${input.lifecycle_id}` : "";
  return maintenance.handle(new Request(`https://runner.internal/update-maintenance/${action}${suffix}`, { method: read ? "GET" : "POST", ...(read ? {} : { body }) }), body);
}
function scoped() { return env.RUNNER.get(env.RUNNER.idFromName(`update-maintenance-${crypto.randomUUID()}`)); }
const active = (pending = 1): MaintenanceConnection => ({ lifecycle_id: owner.lifecycle_id, epoch: 4, session_id: "old-session", pending, open: true });

describe("Runner update maintenance fencing", () => {
  it("retries a failed initial storage read and recovers the persisted fence without writing", async () => {
    await runInDurableObject(scoped(), async (_instance, state) => {
      const f = fixture(state.storage); await call(f.maintenance, "begin");
      const restarted = new RunnerUpdateMaintenance(f.ports);
      const get = vi.spyOn(state.storage, "get").mockRejectedValueOnce(new Error("transient storage read"));
      const put = vi.spyOn(state.storage, "put");
      try {
        await expect(restarted.load()).rejects.toThrow("transient storage read");
        expect(restarted.blocksLifecycle(owner.lifecycle_id)).toBe(true);
        await restarted.load();
        expect(restarted.blocksLifecycle(owner.lifecycle_id)).toBe(true);
        expect(restarted.blocksLifecycle("new-installation")).toBe(false);
        expect(await (await call(restarted, "read")).json()).toEqual({ cloud_drained: true, cloud_uncertain: false });
        expect(get).toHaveBeenCalledTimes(4); expect(put).not.toHaveBeenCalled();
      } finally { get.mockRestore(); put.mockRestore(); }
    });
  });

  it("fences actual RPC dispatch, waits for real replies and survives a RunnerDO restart", async () => {
    await runInDurableObject(scoped(), async (_existing, state) => {
      let attachment: any = { runnerId: owner.runner_id, lifecycleId: owner.lifecycle_id, sessionId: "old-session", epoch: 0, credentialVersion: 1, protocolVersion: 0, authenticated: true, helloDeadlineMs: Date.now() + 10_000 };
      let requestId = ""; let sent!: () => void; let registryLifecycle = owner.lifecycle_id;
      const sentPromise = new Promise<void>(resolve => { sent = resolve; });
      const send = vi.fn((raw: string) => { const message = decodeWireFrame(raw); if (message.type === "rpc.request") { requestId = message.request_id; sent(); } });
      const socket = { readyState: WebSocket.OPEN, send, close: vi.fn(), deserializeAttachment: () => attachment, serializeAttachment: (value: unknown) => { attachment = value; } } as unknown as WebSocket;
      const statePort = new Proxy(state, { get(target, key) { if (key === "getWebSockets") return () => [socket]; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
      const registry = async (_id: string, path: string) => {
        if (path === "/connect") return Response.json({ epoch: 4, lifecycle_id: registryLifecycle });
        if (path === "/session") return new Response(null, { status: 204 });
        if (path.startsWith("/update/evidence?")) return Response.json({ update: { operation: operation(), cloud_drained: false, observed_version: "0.1.7", observed_new_session: false }, claim_epoch: 4, connection_epoch: 4 });
        throw new Error(`unexpected route ${path}`);
      };
      const instance = new RunnerDO(statePort, env, { registryRequest: registry });
      await instance.webSocketMessage(socket, encodeWireFrame({ type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
        runner: { runner_id: owner.runner_id, runner_version: "0.1.7", platform: "test", architecture: "test", capabilities: { filesystem: true, process_execution: true, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 2, supported_rpc_methods: [], labels: {} } } }));
      const request = async (instance: RunnerDO, path: string, payload?: Record<string, unknown>) => {
        const method = payload === undefined ? "GET" : "POST", body = payload === undefined ? "" : JSON.stringify(payload);
        return instance.fetch(new Request(`https://runner.internal${path}`, { method, headers: await internalHeaders("test-internal-control-secret-not-for-production", method, path, body), ...(payload === undefined ? {} : { body }) }));
      };
      const rpc = request(instance, "/rpc", { method: "echo", params: { message: "in flight" } }); await sentPromise;
      expect(attachment.pendingUpdateRpcIds).toEqual([requestId]);
      expect(await (await request(instance, "/update-maintenance/begin", owner)).json()).toEqual({ cloud_drained: false, cloud_uncertain: false });
      expect((await request(instance, "/rpc", { method: "echo", params: {} })).status).toBe(409);
      await instance.webSocketMessage(socket, encodeWireFrame({ type: "rpc.response", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: requestId, result: { message: "done" } }));
      expect((await rpc).status).toBe(200); expect(attachment.pendingUpdateRpcIds).toEqual([]);
      const read = `/update-maintenance/read?operation_id=${owner.operation_id}&lifecycle_id=${owner.lifecycle_id}`;
      expect(await (await request(instance, read)).json()).toEqual({ cloud_drained: true, cloud_uncertain: false });
      const restarted = new RunnerDO(statePort, env, { registryRequest: registry });
      expect((await request(restarted, "/rpc", { method: "echo", params: {} })).status).toBe(409);
      expect(send.mock.calls.filter(([raw]) => decodeWireFrame(raw).type === "rpc.request")).toHaveLength(1);
      // Deleting and recreating the same Runner ID establishes a different authenticated lifecycle.
      registryLifecycle = "b".repeat(64);
      attachment = { ...attachment, lifecycleId: registryLifecycle, sessionId: "replacement-installation", epoch: 0, protocolVersion: 0, pendingUpdateRpcIds: [] };
      await restarted.webSocketMessage(socket, encodeWireFrame({ type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "new-hello", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
        runner: { runner_id: owner.runner_id, runner_version: "0.1.7", platform: "test", architecture: "test", capabilities: { filesystem: true, process_execution: true, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 2, supported_rpc_methods: [], labels: {} } } }));
      const replacementSent = new Promise<void>(resolve => { sent = resolve; });
      const replacementRpc = request(restarted, "/rpc", { method: "echo", params: { message: "replacement" } }); await replacementSent;
      await restarted.webSocketMessage(socket, encodeWireFrame({ type: "rpc.response", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: requestId, result: {} }));
      expect((await replacementRpc).status).toBe(200);
    });
  });

  it("waits for actual replies, preserves the fence across reconstruction, and does not rewrite duplicate claims", async () => {
    await runInDurableObject(scoped(), async (_instance, state) => {
      const f = fixture(state.storage); f.setPending(1); f.setConnections([active()]);
      expect(await (await call(f.maintenance, "begin")).json()).toEqual({ cloud_drained: false, cloud_uncertain: false });
      expect(f.maintenance.blocked).toBe(true);
      const put = vi.spyOn(state.storage, "put");
      try { expect((await call(f.maintenance, "begin")).status).toBe(200); expect(put).not.toHaveBeenCalled(); }
      finally { put.mockRestore(); }
      // A bridge timeout removes its HTTP waiter, but the real socket request is still unresolved.
      f.setPending(0);
      expect(await (await call(f.maintenance, "read")).json()).toEqual({ cloud_drained: false, cloud_uncertain: false });
      f.setConnections([active(0)]);
      expect(await (await call(f.maintenance, "read")).json()).toEqual({ cloud_drained: true, cloud_uncertain: false });
      const restarted = new RunnerUpdateMaintenance(f.ports); await restarted.load(); expect(restarted.blocked).toBe(true);
      f.setOperation({ ...operation(), state: "succeeded" });
      expect((await call(restarted, "finish")).status).toBe(200); expect(restarted.blocked).toBe(false);
    });
  });

  it("recovers only disconnected uncertainty after a matching stopped-process proof and rejects new-session replays", async () => {
    await runInDurableObject(scoped(), async (_instance, state) => {
      const f = fixture(state.storage);
      await call(f.maintenance, "begin");
      const closed = { ...active(), open: false };
      await f.maintenance.disconnected(closed); f.setConnections([closed]);
      expect(await (await call(f.maintenance, "read")).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
      expect((await call(f.maintenance, "drain-proof")).status).toBe(409);
      f.setConnections([active(0)]);
      expect((await call(f.maintenance, "drain-proof", { ...owner, old_process_stopped: true })).status).toBe(409);
      f.setConnections([closed]);
      expect(await (await call(f.maintenance, "drain-proof", { ...owner, old_process_stopped: true })).json()).toEqual({ cloud_drained: true, cloud_uncertain: false });
      const put = vi.spyOn(state.storage, "put"), remove = vi.spyOn(state.storage, "delete");
      try {
        expect((await call(f.maintenance, "drain-proof", { ...owner, old_process_stopped: true })).status).toBe(200);
        await f.maintenance.disconnected(closed);
        expect(put).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
      } finally { put.mockRestore(); remove.mockRestore(); }
      f.setEpoch(5); f.setConnections([{ ...active(), epoch: 5, open: false }]);
      await f.maintenance.disconnected({ ...closed, epoch: 5, session_id: "new-session" });
      // A late close from a replaced installation cannot erase current-lifecycle uncertainty.
      await f.maintenance.disconnected({ ...closed, lifecycle_id: "previous-installation", epoch: 99, session_id: "unrelated-session" });
      expect((await call(f.maintenance, "drain-proof", { ...owner, old_process_stopped: true })).status).toBe(409);
      expect(await (await call(f.maintenance, "read")).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
    });
  });

  it("never uses process-stop assertions to skip a live RPC or mismatching operation", async () => {
    await runInDurableObject(scoped(), async (_instance, state) => {
      const f = fixture(state.storage); f.setConnections([active()]);
      await call(f.maintenance, "begin");
      expect((await call(f.maintenance, "drain-proof", { ...owner, old_process_stopped: true })).status).toBe(409);
      f.setConnections([]);
      expect((await call(f.maintenance, "drain-proof", { ...owner, old_process_stopped: true })).status).toBe(409);
      await f.maintenance.disconnected({ ...active(), open: false });
      expect((await call(f.maintenance, "drain-proof", { ...owner, operation_id: "other", old_process_stopped: true })).status).toBe(409);
      expect((await call(f.maintenance, "drain-proof", { ...owner, manager_id: "other", old_process_stopped: true })).status).toBe(409);
      f.setPending(1);
      expect((await call(f.maintenance, "drain-proof", { ...owner, old_process_stopped: true })).status).toBe(409);
    });
  });

  it("keeps rollback failure fenced and does not let a stale finalizer clear a newer operation", async () => {
    await runInDurableObject(scoped(), async (_instance, state) => {
      const f = fixture(state.storage); await call(f.maintenance, "begin");
      f.setOperation({ ...operation(), state: "failed", error_code: "rollback_failed" });
      expect((await call(f.maintenance, "finish")).status).toBe(409); expect(f.maintenance.blocked).toBe(true);
      expect(f.maintenance.blocksLifecycle("new-installation")).toBe(false);
      f.setOperation({ ...operation(), operation_id: "operation-2" });
      expect((await call(f.maintenance, "begin", { ...owner, operation_id: "operation-2" })).status).toBe(200);
      expect((await call(f.maintenance, "finish")).status).toBe(409); expect(f.maintenance.blocked).toBe(true);
    });
  });

  it("retries an uncertain fence write before reporting cloud drain", async () => {
    await runInDurableObject(scoped(), async (_instance, state) => {
      const f = fixture(state.storage);
      const original = state.storage.put.bind(state.storage); let failures = 1;
      const put = vi.spyOn(state.storage, "put").mockImplementation(((...args: unknown[]) => {
        if (failures-- > 0) return Promise.reject(new Error("storage unavailable"));
        return (original as (...values: unknown[]) => Promise<void>)(...args);
      }) as typeof state.storage.put);
      try {
        await expect(call(f.maintenance, "begin")).rejects.toThrow("storage unavailable");
        expect(f.maintenance.blocked).toBe(true);
        expect(await (await call(f.maintenance, "read")).json()).toEqual({ cloud_drained: false, cloud_uncertain: false });
        expect(await (await call(f.maintenance, "begin")).json()).toEqual({ cloud_drained: true, cloud_uncertain: false });
        expect(put).toHaveBeenCalledTimes(2);
      } finally { put.mockRestore(); }
    });
  });
});
