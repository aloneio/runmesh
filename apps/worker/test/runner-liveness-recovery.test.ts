import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, type RunnerMetadata } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";
import { internalHeaders } from "../src/security.js";

async function recoveringRunner(retainSession = false) {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName("liveness-recovery-" + crypto.randomUUID()));
  const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const runnerId = "recovering-runner", sessionId = "recovering-session";
  const metadata: RunnerMetadata = { runner_id: runnerId, runner_version: "0.1.7", platform: "linux", architecture: "x64",
    capabilities: { filesystem: true, process_execution: true, workspace_sync: true, pty: false, network_access: false,
      max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } };
  let identity!: { epoch: number; credential_version: number; lifecycle_id: string; session_id: string };
  const request = async (action: string, extra: Record<string, unknown>, send: (request: Request) => Promise<Response> = request => stub.fetch(request)) => {
    const path = "/runners/" + runnerId + "/" + action, body = JSON.stringify({ ...identity, ...extra });
    const headers = await internalHeaders("test-internal-control-secret-not-for-production", "POST", path, body);
    return send(new Request("https://registry.internal" + path, { method: "POST", body, headers }));
  };
  try {
    await runInDurableObject(stub, async (instance, state) => {
      expect(instance.registerRunner(runnerId, "a".repeat(64), now, undefined, "dedicated_user")).toBe(true);
      const initial = instance.getRunnerExecutionState(runnerId)!;
      const epoch = instance.beginConnection(runnerId, metadata, { min_protocol_version: PROTOCOL_MIN_VERSION,
        max_protocol_version: PROTOCOL_CURRENT_VERSION }, sessionId, initial.runner.credential_version, now, initial.lifecycle_id);
      expect(epoch).toBeDefined();
      identity = { epoch: epoch!, credential_version: initial.runner.credential_version, lifecycle_id: initial.lifecycle_id, session_id: sessionId };
      if (retainSession) {
        instance.setupAdmin("synthetic-admin", now);
        expect(instance.createAdminSession("a".repeat(64), "b".repeat(64), now + 600_000, now, 1)).toBe(true);
      }
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBe(now + 45_000);
    });
    clock.mockReturnValue(now + 45_001);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (instance, state) => {
      expect(instance.getRunner(runnerId)?.state).toBe("stale");
      expect(await state.storage.getAlarm()).toBe(retainSession ? now + 900_000 : null);
    });
    const recoveredAt = now + 60_000;
    clock.mockReturnValue(recoveredAt);
    return { stub, clock, now, recoveredAt, runnerId, identity, request };
  } catch (error) { clock.mockRestore(); throw error; }
}

it.each([false, true])("recovered heartbeat restores liveness before retained history: %s", async retainSession => {
  const f = await recoveringRunner(retainSession);
  try {
    expect((await f.request("heartbeat", { now_ms: f.recoveredAt })).status).toBe(204);
    await runInDurableObject(f.stub, async (instance, state) => {
      expect(instance.getRunner(f.runnerId)?.state).toBe("online");
      expect(await state.storage.getAlarm()).toBe(f.recoveredAt + 45_000);
    });
    f.clock.mockReturnValue(f.recoveredAt + 45_001);
    expect(await runDurableObjectAlarm(f.stub)).toBe(true);
    expect((await f.request("session", { require_online: true })).status).toBe(409);
  } finally { f.clock.mockRestore(); }
});

it("the online session route expires a recovered heartbeat without a dashboard read", async () => {
  const f = await recoveringRunner();
  try {
    expect((await f.request("heartbeat", { now_ms: f.recoveredAt })).status).toBe(204);
    f.clock.mockReturnValue(f.recoveredAt + 45_001);
    await runDurableObjectAlarm(f.stub);
    // Probe the signed transport route first: getRunner() can lazily persist
    // stale state and otherwise hide a lost background liveness alarm.
    expect((await f.request("session", { require_online: true })).status).toBe(409);
    await runInDurableObject(f.stub, async (instance, state) => {
      expect(instance.getRunner(f.runnerId)?.state).toBe("stale");
      expect(await state.storage.getAlarm()).toBeNull();
    });
  } finally { f.clock.mockRestore(); }
});

it("healthy heartbeats preserve their SQL budget and keep the existing alarm", async () => {
  const f = await recoveringRunner();
  try {
    expect((await f.request("heartbeat", { now_ms: f.recoveredAt })).status).toBe(204);
    await runInDurableObject(f.stub, async (instance, state) => {
      const original = state.storage.sql.exec.bind(state.storage.sql);
      let rowsWritten = 0;
      const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
        const cursor = original(query, ...args); rowsWritten += cursor.rowsWritten; return cursor;
      });
      const alarm = vi.spyOn(state.storage, "setAlarm");
      const alarmReads = vi.spyOn(state.storage, "getAlarm");
      try {
        for (let index = 0; index < 20; index++) expect((await f.request("heartbeat", { now_ms: f.recoveredAt }, request => instance.fetch(request))).status).toBe(204);
        expect(rowsWritten).toBe(0);
        expect(alarm).not.toHaveBeenCalled();
        expect(alarmReads).toHaveBeenCalledTimes(20);
        sql.mockClear();
        for (let index = 1; index <= 10; index++) {
          f.clock.mockReturnValue(f.recoveredAt + index * 1000);
          expect((await f.request("heartbeat", { now_ms: Date.now() }, request => instance.fetch(request))).status).toBe(204);
        }
        expect(sql.mock.calls).toHaveLength(10);
        expect(sql.mock.calls.every(([query]) => query.startsWith("UPDATE runners SET state = 'online'"))).toBe(true);
        expect(rowsWritten).toBeLessThanOrEqual(10 * 4);
        expect(alarm).not.toHaveBeenCalled();
        expect(alarmReads).toHaveBeenCalledTimes(30);
      } finally { sql.mockRestore(); alarm.mockRestore(); alarmReads.mockRestore(); }
    });
  } finally { f.clock.mockRestore(); }
});

it("concurrent recovered heartbeats share one alarm and rejected sessions schedule nothing", async () => {
  const f = await recoveringRunner();
  try {
    await runInDurableObject(f.stub, async (instance, state) => {
      const alarm = vi.spyOn(state.storage, "setAlarm"), reads = vi.spyOn(state.storage, "getAlarm");
      try {
        expect((await f.request("heartbeat", { now_ms: f.recoveredAt, epoch: f.identity.epoch + 1 }, request => instance.fetch(request))).status).toBe(409);
        expect(alarm).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled();
        const responses = await Promise.all([0, 1].map(() => f.request("heartbeat", { now_ms: f.recoveredAt }, request => instance.fetch(request))));
        expect(responses.map(response => response.status)).toEqual([204, 204]);
        expect(alarm).toHaveBeenCalledExactlyOnceWith(f.recoveredAt + 45_000);
      } finally { alarm.mockRestore(); reads.mockRestore(); }
    });
  } finally { f.clock.mockRestore(); }
});

it.each(["getAlarm", "setAlarm"] as const)("heartbeat recovery survives a %s storage outage", async operation => {
  const f = await recoveringRunner();
  try {
    await runInDurableObject(f.stub, async (instance, state) => {
      const fault = vi.spyOn(state.storage, operation).mockRejectedValue(new Error("synthetic alarm storage outage"));
      try {
        expect((await f.request("heartbeat", { now_ms: f.recoveredAt }, request => instance.fetch(request))).status).toBe(204);
        expect(instance.getRunner(f.runnerId)?.state).toBe("online");
        expect(instance.featureHealthSnapshot(f.recoveredAt).some(feature => feature.feature === "maintenance_alarm")).toBe(true);
        const calls = fault.mock.calls.length;
        expect((await f.request("heartbeat", { now_ms: f.recoveredAt }, request => instance.fetch(request))).status).toBe(204);
        expect(fault.mock.calls.length).toBe(calls);
      } finally { fault.mockRestore(); }
    });
  } finally { f.clock.mockRestore(); }
});
