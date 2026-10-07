import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { RunnerUpdateMaintenance, type MaintenanceConnection } from "../src/platform/runner-update-maintenance.js";
import type { RunnerUpdateOperation } from "@aloneio/runmesh-protocol";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, decodeWireFrame, encodeWireFrame } from "@aloneio/runmesh-protocol";
import { RunnerDO } from "../src/runner-do.js";
import { BridgeReplies } from "../src/platform/bridge-replies.js";
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
  it("retains the newest disconnect while retrying an earlier failed uncertainty write", async () => {
    await runInDurableObject(scoped(), async (_instance, state) => {
      const f = fixture(state.storage); await call(f.maintenance, "begin");
      const put = vi.spyOn(state.storage, "put").mockRejectedValue(new Error("uncertainty storage unavailable"));
      try {
        await expect(f.maintenance.disconnected({ ...active(), open: false })).rejects.toThrow("unavailable");
        await expect(f.maintenance.disconnected({ ...active(), epoch: 5, session_id: "newer-session", open: false })).rejects.toThrow("unavailable");
        put.mockRestore(); await f.maintenance.load();
        expect(await state.storage.get("runner-update-uncertain-rpc-v1")).toEqual({
          [owner.lifecycle_id]: { lifecycle_id: owner.lifecycle_id, epoch: 5, session_id: "newer-session" },
        });
        expect(await (await call(f.maintenance, "read")).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
        expect((await call(f.maintenance, "drain-proof", { ...owner, old_process_stopped: true })).status).toBe(409);
      } finally { put.mockRestore(); }
    });
  });

  it("does not revive a proved disconnect before the restarted maintenance state loads", async () => {
    await runInDurableObject(scoped(), async (_instance, state) => {
      const f = fixture(state.storage); await call(f.maintenance, "begin");
      const closed = { ...active(), open: false };
      await f.maintenance.disconnected(closed);
      expect((await call(f.maintenance, "drain-proof", { ...owner, old_process_stopped: true })).status).toBe(200);
      const restarted = new RunnerUpdateMaintenance(f.ports);
      const put = vi.spyOn(state.storage, "put");
      try {
        await restarted.disconnected(closed);
        expect(await (await call(restarted, "read")).json()).toEqual({ cloud_drained: true, cloud_uncertain: false });
        expect(put).not.toHaveBeenCalled();
      } finally { put.mockRestore(); }
    });
  });

  for (const key of ["runner-update-maintenance-v1", "runner-update-uncertain-rpc-v1"]) {
    it(`retains disconnected work across a failed initial ${key} read and recovery without the socket`, async () => {
      await runInDurableObject(scoped(), async (_existing, state) => {
        await call(fixture(state.storage).maintenance, "begin");
        const attachment = { runnerId: owner.runner_id, lifecycleId: owner.lifecycle_id, sessionId: "read-failure-session", epoch: 4,
          credentialVersion: 1, protocolVersion: PROTOCOL_CURRENT_VERSION, authenticated: true,
          helloDeadlineMs: Date.now() + 60_000, pendingUpdateRpcIds: ["pending-rpc"] };
        const socket = { readyState: WebSocket.CLOSED, deserializeAttachment: () => attachment } as unknown as WebSocket;
        let sockets = [socket];
        const statePort = new Proxy(state, { get(target, key) {
          if (key === "getWebSockets") return () => sockets;
          const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
        } });
        const replies = new BridgeReplies(), resolve = vi.fn(), registry = vi.fn(async () => new Response(null, { status: 204 }));
        const timer = setTimeout(() => undefined, 60_000);
        replies.register("pending-rpc", { socket, timer, resolve });
        const instance = new RunnerDO(statePort, env, { replies, registryRequest: registry });
        const originalGet = state.storage.get.bind(state.storage);
        const get = vi.spyOn(state.storage, "get").mockImplementation(((...args: unknown[]) => {
          if (args[0] === key) return Promise.reject(new Error("initial maintenance read unavailable"));
          return (originalGet as (...values: unknown[]) => Promise<unknown>)(...args);
        }) as typeof state.storage.get);
        try {
          await expect(instance.webSocketClose(socket)).rejects.toThrow("initial maintenance read unavailable");
          expect(replies.size).toBe(0); expect(resolve).toHaveBeenCalledTimes(1); expect(registry).toHaveBeenCalledTimes(1);
          sockets = []; get.mockRestore();
          const path = `/update-maintenance/read?operation_id=${owner.operation_id}&lifecycle_id=${owner.lifecycle_id}`;
          const read = async (target: RunnerDO) => target.fetch(new Request(`https://runner.internal${path}`, {
            headers: await internalHeaders("test-internal-control-secret-not-for-production", "GET", path, ""),
          }));
          expect(await (await read(instance)).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
          const restarted = new RunnerDO(statePort, env, { registryRequest: registry });
          expect(await (await read(restarted)).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
        } finally { get.mockRestore(); clearTimeout(timer); replies.forget("pending-rpc"); }
      });
    });
  }

  for (const event of ["close", "error"] as const) for (const fault of ["none", "uncertainty", "reply", "registry", "alarm", "combined"] as const) {
    it(`${event} independently cleans up transport and retains maintenance evidence when ${fault} fails`, async () => {
      await runInDurableObject(scoped(), async (_existing, state) => {
        await call(fixture(state.storage).maintenance, "begin");
        const alarmAt = Date.now() + 60_000;
        await state.storage.setAlarm(alarmAt);
        const attachment = { runnerId: owner.runner_id, lifecycleId: owner.lifecycle_id, sessionId: "closed-session", epoch: 4,
          credentialVersion: 1, protocolVersion: PROTOCOL_CURRENT_VERSION, authenticated: true,
          helloDeadlineMs: alarmAt, pendingUpdateRpcIds: ["pending-rpc"] };
        const socket = { readyState: WebSocket.CLOSED, deserializeAttachment: () => attachment } as unknown as WebSocket;
        const statePort = new Proxy(state, { get(target, key) {
          if (key === "getWebSockets") return () => [socket];
          const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
        } });
        const replies = new BridgeReplies(), resolve = vi.fn();
        if (fault === "reply" || fault === "combined") resolve.mockImplementation(() => { throw new Error("reply unavailable"); });
        const timer = setTimeout(() => undefined, 60_000);
        replies.register("pending-rpc", { socket, timer, resolve });
        const registry = vi.fn(async (_id: string, path: string, init?: RequestInit) => {
          if (path !== "/disconnect") throw new Error(`unexpected registry route: ${path}`);
          expect(JSON.parse(String(init?.body))).toMatchObject({ epoch: 4, state: event === "close" ? "offline" : "stale" });
          if (fault === "registry" || fault === "combined") throw new Error("registry unavailable");
          return new Response(null, { status: 204 });
        });
        const instance = new RunnerDO(statePort, env, { replies, registryRequest: registry });
        const originalPut = state.storage.put.bind(state.storage);
        const put = vi.spyOn(state.storage, "put").mockImplementation(((...args: unknown[]) => {
          if (args[0] === "runner-update-uncertain-rpc-v1" && (fault === "uncertainty" || fault === "combined")) throw new Error("uncertainty write unavailable");
          return (originalPut as (...values: unknown[]) => Promise<void>)(...args);
        }) as typeof state.storage.put);
        const removeAlarm = vi.spyOn(state.storage, "deleteAlarm");
        if (fault === "alarm" || fault === "combined") removeAlarm.mockRejectedValue(new Error("alarm unavailable"));
        try {
          const closed = event === "close" ? instance.webSocketClose(socket) : instance.webSocketError(socket);
          if (fault === "none") await closed;
          else if (fault === "combined") await expect(closed).rejects.toBeInstanceOf(AggregateError);
          else await expect(closed).rejects.toThrow("unavailable");
          expect(replies.size).toBe(0);
          expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "rpc.error", request_id: "pending-rpc",
            error: expect.objectContaining({ code: "runner_offline" }) }));
          expect(registry).toHaveBeenCalledTimes(1);
          expect(removeAlarm).toHaveBeenCalledTimes(1);
          expect(await state.storage.getAlarm()).toBe(fault === "alarm" || fault === "combined" ? alarmAt : null);
          expect(attachment.pendingUpdateRpcIds).toEqual(["pending-rpc"]);
          const path = `/update-maintenance/read?operation_id=${owner.operation_id}&lifecycle_id=${owner.lifecycle_id}`;
          if (fault === "uncertainty" || fault === "combined") {
            const unavailable = await instance.fetch(new Request(`https://runner.internal${path}`, { headers: await internalHeaders("test-internal-control-secret-not-for-production", "GET", path, "") }));
            expect(unavailable.status).toBe(503);
          }
          put.mockRestore();
          const response = await instance.fetch(new Request(`https://runner.internal${path}`, { headers: await internalHeaders("test-internal-control-secret-not-for-production", "GET", path, "") }));
          expect(await response.json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
          if (fault === "uncertainty") {
            if (event === "close") await instance.webSocketClose(socket);
            else await instance.webSocketError(socket);
            expect(await state.storage.get("runner-update-uncertain-rpc-v1")).toEqual({ [owner.lifecycle_id]: { lifecycle_id: owner.lifecycle_id, epoch: 4, session_id: "closed-session" } });
            expect(resolve).toHaveBeenCalledTimes(1);
          }
        } finally {
          put.mockRestore(); removeAlarm.mockRestore(); clearTimeout(timer); replies.forget("pending-rpc"); await state.storage.deleteAlarm();
        }
      });
    });
  }

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
