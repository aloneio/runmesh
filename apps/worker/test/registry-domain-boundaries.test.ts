import { expect, it } from "vitest";
import { RegistryAuth } from "../src/registry/auth.js";
import { RegistryPolicy } from "../src/registry/policy.js";
import { RegistryLifecycle } from "../src/registry/lifecycle.js";
import { RegistryHistory } from "../src/registry/history.js";
import { registryStorage, type RegistryStorage } from "../src/registry/storage.js";
import type { AuthPorts, PolicyPorts, LifecyclePorts, HistoryPorts } from "../src/registry/ports.js";

it("AR06 domain construction requires no DO, remote adapter or storage access", () => {
  const forbidden = new Proxy({}, { get() { throw new Error("construction must not access collaborators"); } });
  const storage = forbidden as RegistryStorage;
  expect(() => new RegistryAuth(storage, forbidden as AuthPorts)).not.toThrow();
  expect(() => new RegistryPolicy(storage, forbidden as PolicyPorts, "d1")).not.toThrow();
  expect(() => new RegistryLifecycle(storage, forbidden as LifecyclePorts, undefined)).not.toThrow();
  expect(() => new RegistryHistory(storage, forbidden as HistoryPorts)).not.toThrow();
});

it("AR06 SQL adapter returns the native storage and synchronous transaction result unchanged", () => {
  let transactions = 0, sqlReads = 0;
  const sql = {} as SqlStorage;
  const native = { get sql() { sqlReads++; return sql; }, transactionSync<T>(callback: () => T): T { transactions++; return callback(); } };
  const storage = registryStorage(native);
  expect(sqlReads).toBe(0); expect(transactions).toBe(0);
  expect(storage.sql).toBe(sql);
  const receipt = { applied: true };
  expect(storage.transactionSync(() => receipt)).toBe(receipt);
  expect(transactions).toBe(1);
  const failure = new Error("synthetic SQLite failure");
  expect(() => storage.transactionSync(() => { throw failure; })).toThrow(failure);
  expect(transactions).toBe(2);
});

it("AR06 heartbeat can use a minimal synchronous SQL port without an auth or network service", () => {
  let queries = 0;
  const storage = { sql: { exec() { queries++; return { rowsWritten: 1 }; } } } as unknown as RegistryStorage;
  const ports = new Proxy({}, { get() { throw new Error("heartbeat may not call peer services"); } }) as LifecyclePorts;
  const lifecycle = new RegistryLifecycle(storage, ports, undefined);
  expect(lifecycle.recordHeartbeat("r", 1, 1, 100, "a-valid-lifecycle-id", "session")).toBe(true);
  expect(queries).toBe(1);
});

it("AR06 invalid authorization returns before any SQL or other collaborator is used", () => {
  const storage = new Proxy({}, { get() { throw new Error("no storage for an invalid principal"); } }) as RegistryStorage;
  let observed = 0;
  const ports = new Proxy({ revalidateMcpClient() { observed++; return undefined; } }, {
    get(target, property) { if (property !== "revalidateMcpClient") throw new Error("no other collaborator"); return target.revalidateMcpClient; },
  }) as unknown as PolicyPorts;
  expect(new RegistryPolicy(storage, ports, "d1").authorizeMcpRpc({ client_id: "missing", secret_version: 1 })).toEqual({ ok: false, code: "permission_denied" });
  expect(observed).toBe(1);
});

it("AR06 history read needs only its SQL port and preserves an absent job", () => {
  let queries = 0;
  const storage = { sql: { exec() { queries++; return { toArray: () => [] }; } } } as unknown as RegistryStorage;
  const ports = new Proxy({}, { get() { throw new Error("no peer for a direct history read"); } }) as HistoryPorts;
  expect(new RegistryHistory(storage, ports).getJob("r", "missing")).toBeUndefined();
  expect(queries).toBe(1);
});
