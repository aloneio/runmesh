import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { RunnerUpdateMaintenance } from "../src/platform/runner-update-maintenance.js";
import type { RunnerUpdateOperation } from "@aloneio/runmesh-protocol";

const owner = { runner_id: "cold-disconnect", operation_id: "operation-1", lifecycle_id: "a".repeat(64), manager_id: "manager-1", credential_version: 1 };
const key = "runner-update-maintenance-v1", uncertainKey = "runner-update-uncertain-rpc-v1";
const operation: RunnerUpdateOperation = { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id, target_version: "0.1.7-dev.42",
  target_channel: "dev", manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64), original_version: "0.1.7", manager_id: owner.manager_id,
  state: "draining", error_code: null, created_at_ms: 1, updated_at_ms: 1 };
const connection = (epoch = 4) => ({ lifecycle_id: owner.lifecycle_id, epoch, session_id: `session-${epoch}`, pending: 1, open: false });
const evidence = (epoch: number) => ({ lifecycle_id: owner.lifecycle_id, epoch, session_id: `session-${epoch}` });
function fixture(storage: DurableObjectStorage) {
  return new RunnerUpdateMaintenance({ storage, connections: () => [], pendingReplies: () => 0,
    registry: async () => Response.json({ update: { operation, cloud_drained: false, cloud_uncertain: false, observed_version: null, observed_new_session: false },
      claim_epoch: 4, connection_epoch: 4 }) });
}
async function call(instance: RunnerUpdateMaintenance, action = "read") {
  const body = action === "read" ? "" : JSON.stringify({ ...owner, old_process_stopped: true });
  const suffix = action === "read" ? `?operation_id=${owner.operation_id}&lifecycle_id=${owner.lifecycle_id}` : "";
  return instance.handle(new Request(`https://runner.internal/update-maintenance/${action}${suffix}`, { method: action === "read" ? "GET" : "POST", ...(body ? { body } : {}) }), body);
}
const scoped = () => env.RUNNER.get(env.RUNNER.idFromName("maintenance-recovery-" + crypto.randomUUID()));

for (const failedKey of [key, uncertainKey]) for (const proven of [false, true]) {
  it(`retains cold disconnect evidence through ${failedKey} read failure; proven=${proven}`, async () => {
    await runInDurableObject(scoped(), async (_instance, state) => {
      await state.storage.put(key, { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id, ...(proven ? { proven_epoch: 4 } : {}) });
      const instance = fixture(state.storage), original = state.storage.get.bind(state.storage);
      let fail = true;
      const get = vi.spyOn(state.storage, "get").mockImplementation(((...args: unknown[]) => {
        if (args[0] === failedKey && fail) { fail = false; return Promise.reject(new Error("read unavailable")); }
        return (original as (...args: unknown[]) => Promise<unknown>)(...args);
      }) as typeof state.storage.get);
      try {
        await expect(instance.disconnected(connection())).rejects.toThrow("read unavailable");
        // Both transport ports are already empty, as after successful socket cleanup.
        expect(await (await call(instance)).json()).toEqual({ cloud_drained: proven, cloud_uncertain: !proven });
        expect(await state.storage.get(uncertainKey)).toEqual(proven ? undefined : { [owner.lifecycle_id]: evidence(4) });
        expect(await (await call(fixture(state.storage))).json()).toEqual({ cloud_drained: proven, cloud_uncertain: !proven });
        await instance.disconnected(connection());
        expect(await state.storage.get(uncertainKey)).toEqual(proven ? undefined : { [owner.lifecycle_id]: evidence(4) });
        expect(await (await call(fixture(state.storage))).json()).toEqual({ cloud_drained: proven, cloud_uncertain: !proven });
        if (!proven) expect(await (await call(instance, "drain-proof")).json()).toEqual({ cloud_drained: true, cloud_uncertain: false });
      } finally { get.mockRestore(); }
    });
  });
}

it("preserves the highest local epoch across repeated failed cold loads", async () => {
  await runInDurableObject(scoped(), async (_instance, state) => {
    await state.storage.put(key, { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id, proven_epoch: 4 });
    const instance = fixture(state.storage), original = state.storage.get.bind(state.storage);
    let remaining = 2;
    const get = vi.spyOn(state.storage, "get").mockImplementation(((...args: unknown[]) => {
      if (args[0] === key && remaining-- > 0) return Promise.reject(new Error("read unavailable"));
      return (original as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as typeof state.storage.get);
    try {
      await expect(instance.disconnected(connection(5))).rejects.toThrow();
      await expect(instance.disconnected(connection(4))).rejects.toThrow();
      expect(await (await call(instance)).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
      await instance.disconnected(connection(5));
      expect(await state.storage.get(uncertainKey)).toEqual({ [owner.lifecycle_id]: evidence(5) });
    } finally { get.mockRestore(); }
  });
});

it.each([false, true])("recovers a failed uncertainty write through read alone and persists it across restart (preloaded=%s)", async preloaded => {
  await runInDurableObject(scoped(), async (_instance, state) => {
    await state.storage.put(key, { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id });
    const instance = fixture(state.storage);
    if (preloaded) await instance.load();
    const original = state.storage.put.bind(state.storage);
    let fail = true;
    const put = vi.spyOn(state.storage, "put").mockImplementation(((...args: unknown[]) => {
      if (args[0] === uncertainKey && fail) return Promise.reject(new Error("write unavailable"));
      return (original as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as typeof state.storage.put);
    try {
      await expect(instance.disconnected(connection())).rejects.toThrow("write unavailable");
      await expect(call(instance)).rejects.toThrow("write unavailable");
      fail = false; put.mockClear();
      const responses = await Promise.all([call(instance), call(instance), call(instance)]);
      for (const response of responses) expect(await response.json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
      expect(put).toHaveBeenCalledTimes(1);
      expect(await state.storage.get(uncertainKey)).toEqual({ [owner.lifecycle_id]: evidence(4) });
      expect(await (await call(fixture(state.storage))).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
    } finally { put.mockRestore(); }
  });
});

it("retains a newer disconnect while recovery of an earlier dirty write also fails", async () => {
  await runInDurableObject(scoped(), async (_instance, state) => {
    await state.storage.put(key, { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id });
    const instance = fixture(state.storage); await instance.load();
    const original = state.storage.put.bind(state.storage);
    let fail = true;
    const put = vi.spyOn(state.storage, "put").mockImplementation(((...args: unknown[]) => {
      if (args[0] === uncertainKey && fail) return Promise.reject(new Error("write unavailable"));
      return (original as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as typeof state.storage.put);
    try {
      await expect(instance.disconnected(connection(4))).rejects.toThrow("write unavailable");
      await expect(instance.disconnected(connection(5))).rejects.toThrow("write unavailable");
      fail = false;
      expect(await (await call(instance)).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
      expect(await state.storage.get(uncertainKey)).toEqual({ [owner.lifecycle_id]: evidence(5) });
      expect((await call(instance, "drain-proof")).status).toBe(409);
      expect(await (await call(fixture(state.storage))).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
    } finally { put.mockRestore(); }
  });
});

it("does not mark an older in-flight snapshot as persisted after a newer disconnect", async () => {
  await runInDurableObject(scoped(), async (_instance, state) => {
    await state.storage.put(key, { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id });
    const instance = fixture(state.storage); await instance.load();
    const original = state.storage.put.bind(state.storage);
    let release!: () => void, entered!: () => void, attempts = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const put = vi.spyOn(state.storage, "put").mockImplementation((async (...args: unknown[]) => {
      if (args[0] === uncertainKey) {
        if (++attempts === 1) { entered(); await gate; expect(args[1]).toEqual({ [owner.lifecycle_id]: evidence(4) }); }
        else if (attempts === 2) throw new Error("second write unavailable");
      }
      return (original as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as typeof state.storage.put);
    try {
      const older = instance.disconnected(connection(4)); await started;
      const newer = instance.disconnected(connection(5));
      const rejected = expect(newer).rejects.toThrow("second write unavailable");
      release(); await older; await rejected;
      expect(await (await call(instance)).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
      expect(await state.storage.get(uncertainKey)).toEqual({ [owner.lifecycle_id]: evidence(5) });
      expect((await call(instance, "drain-proof")).status).toBe(409);
    } finally { release(); put.mockRestore(); }
  });
});

it.each(["proof", "cleanup"])("retains a newer disconnect during the drain-proof %s storage window", async phase => {
  await runInDurableObject(scoped(), async (_instance, state) => {
    await state.storage.put(key, { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id });
    const instance = fixture(state.storage); await instance.disconnected(connection(4));
    const originalPut = state.storage.put.bind(state.storage), originalDelete = state.storage.delete.bind(state.storage);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const put = vi.spyOn(state.storage, "put").mockImplementation((async (...args: unknown[]) => {
      if (phase === "proof" && args[0] === key) { entered(); await gate; }
      return (originalPut as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as typeof state.storage.put);
    const remove = vi.spyOn(state.storage, "delete").mockImplementation((async (...args: unknown[]) => {
      if (phase === "cleanup" && args[0] === uncertainKey) { entered(); await gate; }
      return (originalDelete as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as typeof state.storage.delete);
    try {
      const proof = call(instance, "drain-proof"); await started;
      const newer = instance.disconnected(connection(5));
      release(); expect((await proof).status).toBe(409); await newer;
      expect(await state.storage.get(uncertainKey)).toEqual({ [owner.lifecycle_id]: evidence(5) });
      expect(await (await call(fixture(state.storage))).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
    } finally { release(); put.mockRestore(); remove.mockRestore(); }
  });
});

it.each([false, true])("retains a different lifecycle added while proof cleanup is pending (nonempty=%s)", async nonempty => {
  await runInDurableObject(scoped(), async (_instance, state) => {
    await state.storage.put(key, { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id });
    const instance = fixture(state.storage); await instance.disconnected(connection(4));
    const previous = { ...connection(3), lifecycle_id: "b".repeat(64) }, incoming = { ...connection(7), lifecycle_id: "c".repeat(64) };
    if (nonempty) await instance.disconnected(previous);
    const originalPut = state.storage.put.bind(state.storage), originalDelete = state.storage.delete.bind(state.storage);
    let release!: () => void, entered!: () => void, intercepted = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const put = vi.spyOn(state.storage, "put").mockImplementation((async (...args: unknown[]) => {
      if (nonempty && args[0] === uncertainKey && !intercepted) { intercepted = true; entered(); await gate; }
      return (originalPut as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as typeof state.storage.put);
    const remove = vi.spyOn(state.storage, "delete").mockImplementation((async (...args: unknown[]) => {
      if (!nonempty && args[0] === uncertainKey && !intercepted) { intercepted = true; entered(); await gate; }
      return (originalDelete as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as typeof state.storage.delete);
    try {
      const proof = call(instance, "drain-proof"); await started;
      const newer = instance.disconnected(incoming);
      release(); expect(await (await proof).json()).toEqual({ cloud_drained: false, cloud_uncertain: false }); await newer;
      expect(await state.storage.get(uncertainKey)).toEqual({
        ...(nonempty ? { [previous.lifecycle_id]: { lifecycle_id: previous.lifecycle_id, epoch: 3, session_id: "session-3" } } : {}),
        [incoming.lifecycle_id]: { lifecycle_id: incoming.lifecycle_id, epoch: 7, session_id: "session-7" },
      });
      expect(await (await call(fixture(state.storage))).json()).toEqual({ cloud_drained: true, cloud_uncertain: false });
    } finally { release(); put.mockRestore(); remove.mockRestore(); }
  });
});

it("does not erase persisted uncertainty when a late local event is covered by a stored proof", async () => {
  await runInDurableObject(scoped(), async (_instance, state) => {
    await state.storage.put(key, { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id, proven_epoch: 4 });
    await state.storage.put(uncertainKey, { [owner.lifecycle_id]: evidence(4) });
    const instance = fixture(state.storage);
    await instance.disconnected(connection(4));
    expect(await (await call(instance)).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
    expect(await state.storage.get(uncertainKey)).toEqual({ [owner.lifecycle_id]: evidence(4) });
  });
});

it("retains a newer persisted epoch and avoids an unchanged write", async () => {
  await runInDurableObject(scoped(), async (_instance, state) => {
    await state.storage.put(key, { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id });
    await state.storage.put(uncertainKey, { [owner.lifecycle_id]: evidence(6) });
    const instance = fixture(state.storage), put = vi.spyOn(state.storage, "put");
    try {
      await instance.disconnected(connection(4));
      expect(put).not.toHaveBeenCalled();
      expect(await state.storage.get(uncertainKey)).toEqual({ [owner.lifecycle_id]: evidence(6) });
      expect(await (await call(instance)).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
    } finally { put.mockRestore(); }
  });
});

it("merges simultaneous disconnect events arriving during the initial read", async () => {
  await runInDurableObject(scoped(), async (_instance, state) => {
    await state.storage.put(key, { operation_id: owner.operation_id, lifecycle_id: owner.lifecycle_id, proven_epoch: 4 });
    const instance = fixture(state.storage), original = state.storage.get.bind(state.storage);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const get = vi.spyOn(state.storage, "get").mockImplementation((async (...args: unknown[]) => {
      if (args[0] === key) await gate;
      return (original as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as typeof state.storage.get);
    try {
      const first = instance.disconnected(connection(4)), second = instance.disconnected(connection(5));
      release(); await Promise.all([first, second]);
      expect(await state.storage.get(uncertainKey)).toEqual({ [owner.lifecycle_id]: evidence(5) });
      expect(await (await call(instance)).json()).toEqual({ cloud_drained: false, cloud_uncertain: true });
    } finally { release(); get.mockRestore(); }
  });
});
