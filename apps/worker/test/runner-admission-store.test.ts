import { describe, expect, it } from "vitest";
import { FENCED_ADMISSION } from "../src/domain/runner-admission.js";
import { RunnerAdmissionStore } from "../src/runner-do-admission.js";

function fixture() {
  const records = new Map<string, unknown>();
  let failNextPut = false;
  const storage = {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: unknown) => {
      if (failNextPut) { failNextPut = false; throw new Error("quota unavailable"); }
      records.set(key, value);
    },
    delete: async (key: string) => records.delete(key),
  };
  const store = new RunnerAdmissionStore(storage as unknown as Pick<DurableObjectStorage, "get" | "put" | "delete">);
  return { store, records, rejectNextPut: () => { failNextPut = true; } };
}

describe("Runner admission persistence ownership", () => {
  it("restores fenced and rejects stale compare-and-set after another owner commits", async () => {
    const { store } = fixture();
    const initial = await store.read();
    expect(initial).toEqual(FENCED_ADMISSION);
    const owner = { ...initial, runnerId: "runner-a", mutationId: "owner-a", mutationPhase: "precommit" as const };
    expect(await store.compareAndSet(initial, owner)).toBe(true);
    expect(await store.compareAndSet(initial, { ...owner, mutationId: "owner-b" })).toBe(false);
    expect(store.snapshot()).toEqual(owner);
    await store.ensurePersistedFence(owner);
  });

  it("keeps a conservative in-memory fence when a durable admission write is uncertain", async () => {
    const { store, rejectNextPut } = fixture();
    const initial = await store.read();
    const candidate = {
      ...initial, fenced: false, reconciled: true, runnerId: "runner-a",
      activeRevision: 1, desiredRevision: 1, activeChecksum: "a".repeat(64), desiredChecksum: "a".repeat(64),
      mutationId: null, mutationPhase: "idle" as const,
    };
    rejectNextPut();
    await expect(store.compareAndSet(initial, candidate)).rejects.toThrow("quota unavailable");
    expect(store.snapshot()).toMatchObject({
      fenced: true, reconciled: false, activeRevision: null,
      activeChecksum: null, mutationId: "restart-reconcile",
    });
    expect(await store.compareAndSet(initial, candidate)).toBe(false);
  });

  it("publishes mutation fences before persistence and never publishes an unfenced mutation", async () => {
    const { store, rejectNextPut } = fixture();
    const expected = { ...FENCED_ADMISSION, runnerId: "runner-a", mutationId: "owner", mutationPhase: "precommit" as const };
    rejectNextPut();
    await expect(store.fenceAndPersist(expected)).rejects.toThrow("quota unavailable");
    expect(store.snapshot()).toEqual(expected);
    await expect(store.fenceAndPersist({ ...expected, fenced: false })).rejects.toThrow("unfenced");
    store.fenceUncertainMutation("owner");
    expect(store.snapshot()).toMatchObject({ fenced: true, mutationId: "owner" });
  });

  it("prevents an older cold read from overwriting a concurrent mutation fence", async () => {
    let resolveRead!: (value: unknown) => void;
    const firstRead = new Promise<unknown>(resolve => { resolveRead = resolve; });
    let first = true;
    const storage = {
      get: async () => first ? (first = false, firstRead) : undefined,
      put: async () => undefined,
      delete: async () => true,
    };
    const store = new RunnerAdmissionStore(storage as unknown as Pick<DurableObjectStorage, "get" | "put" | "delete">);
    const pending = store.read();
    const owner = { ...FENCED_ADMISSION, mutationId: "new-owner", mutationPhase: "precommit" as const };
    await store.fenceAndPersist(owner);
    resolveRead(FENCED_ADMISSION);
    expect(await pending).toEqual(owner);
    expect(store.snapshot()).toEqual(owner);
  });

  it("serializes writes without poisoning subsequent owners after a rejected operation", async () => {
    const { store } = fixture();
    const order: string[] = [];
    let finish!: () => void;
    const first = store.exclusive(async () => {
      order.push("first-start");
      await new Promise<void>(resolve => { finish = resolve; });
      throw new Error("failed first owner");
    });
    const second = store.exclusive(async () => { order.push("second"); return "ready"; });
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    finish();
    await expect(first).rejects.toThrow("failed first owner");
    await expect(second).resolves.toBe("ready");
    expect(order).toEqual(["first-start", "second"]);
  });
});
