import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { CentralGovernance } from "../src/platform/capabilities/central-audit.js";
import { CentralSchema } from "../src/platform/capabilities/schema.js";
import { CENTRAL_GOVERNANCE_LIMITS as LIMITS } from "../src/contracts/central-audit.js";
const owner = () => (env as unknown as { CAPABILITIES: DurableObjectNamespace }).CAPABILITIES.get((env as unknown as { CAPABILITIES: DurableObjectNamespace }).CAPABILITIES.idFromName(crypto.randomUUID()));
const principal = { client_id: 'client-a', secret_version: 1 }, command = { profile_id: 'profile-a', tool_id: 'mcp.' + 'a'.repeat(64), version: 'b'.repeat(64) };
it("successful Central calls only reset persisted cooldown when it changed", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    const schema = new CentralSchema(state.storage), service = new CentralGovernance(state.storage, () => schema.initialize());
    expect(service.admit(principal, command)).toBe(true);
    const original = state.storage.sql.exec.bind(state.storage.sql), updates: number[] = [];
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      const cursor = original(query, ...args);
      if (query.startsWith("UPDATE central_admission_v1 SET failures=0")) updates.push(cursor.rowsWritten);
      return cursor;
    });
    try {
      expect(service.record(principal, command, { state: "completed", operation_state: "completed" }).audit_status).toBe("recorded");
      expect(updates.splice(0)).toEqual([0]);
      service.record(principal, command, { state: "failed", code: "upstream_unavailable", operation_state: "unknown" });
      expect(service.record(principal, command, { state: "completed", operation_state: "completed" }).audit_status).toBe("recorded");
      // The changed row and its expiry index are written once; unchanged success stays write-free.
      expect(updates.splice(0)).toEqual([2]);
      expect(service.record(principal, command, { state: "completed", operation_state: "completed" }).audit_status).toBe("recorded");
      expect(updates).toEqual([0]);
      expect(service.list()).toHaveLength(4);
    } finally { spy.mockRestore(); }
  });
});

function seedGovernanceV1(storage: DurableObjectStorage, now: number, keys = 2): void {
  const sql = storage.sql;
  sql.exec("CREATE TABLE central_governance_meta (id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL)");
  sql.exec("INSERT INTO central_governance_meta VALUES (1,1)");
  sql.exec("CREATE TABLE central_admission_v1 (key TEXT PRIMARY KEY,window_ms INTEGER NOT NULL,count INTEGER NOT NULL,failures INTEGER NOT NULL,cooldown_ms INTEGER NOT NULL)");
  sql.exec("CREATE TABLE central_receipts_v1 (request_id TEXT PRIMARY KEY,client_id TEXT NOT NULL,profile_id TEXT NOT NULL,tool_id TEXT NOT NULL,version TEXT NOT NULL,operation_state TEXT NOT NULL,code TEXT NOT NULL,created_at_ms INTEGER NOT NULL)");
  for (let index = 0; index < keys; index++) sql.exec("INSERT INTO central_admission_v1 VALUES (?,?,1,0,0)",
    index === 0 ? 'client:' + principal.client_id : index === 1 ? 'profile:' + command.profile_id : 'client:fixture-' + index, now);
  for (let index = 0; index < LIMITS.receipts; index++) sql.exec("INSERT INTO central_receipts_v1 VALUES (?,?,?,?,?,?,?,?)",
    'receipt-' + String(index).padStart(4, '0'), principal.client_id, command.profile_id, command.tool_id, command.version, 'completed', 'completed', now - index);
}

it("Central migrated full stores keep ordinary admission, receipts and recent reads bounded", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    const now = 1_000_000; seedGovernanceV1(state.storage, now, 1000);
    const service = new CentralGovernance(state.storage, () => undefined, () => now);
    expect(service.list()).toHaveLength(50); // Atomic one-time migration precedes steady-state measurement.
    const cursors: SqlStorageCursor[] = [], original = state.storage.sql.exec.bind(state.storage.sql);
    const spy = vi.spyOn(state.storage.sql, 'exec').mockImplementation((query: string, ...args: any[]) => {
      const cursor = original(query, ...args); cursors.push(cursor); return cursor;
    });
    const measure = () => { const result = { read: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0), written: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0) }; cursors.length = 0; return result; };
    try {
      expect(service.admit(principal, command)).toBe(true);
      const admission = measure(); expect(admission.read).toBeLessThanOrEqual(12); expect(admission.written).toBe(2);
      const receipt = service.record(principal, command, { state: 'completed', operation_state: 'completed' });
      expect(receipt.audit_status).toBe('recorded');
      const recorded = measure(); expect(recorded.read).toBeLessThanOrEqual(20); expect(recorded.written).toBeLessThanOrEqual(6);
      expect(service.list()).toHaveLength(50);
      const listed = measure(); expect(listed.read).toBeLessThanOrEqual(100); expect(listed.written).toBe(0);
    } finally { spy.mockRestore(); }
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM central_receipts_v1").one()).toEqual({ count: LIMITS.receipts });
    expect(service.list().some(row => row.request_id === 'receipt-0999')).toBe(false);
    expect(new CentralGovernance(state.storage, () => undefined, () => now).list()).toEqual(service.list());
  });
});

it("Central counted capacity preserves rejection, exact window boundaries and expired-key recovery", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    let now = 1_000_000; seedGovernanceV1(state.storage, now, LIMITS.keys);
    const service = new CentralGovernance(state.storage, () => undefined, () => now);
    expect(service.admit({ ...principal, client_id: 'new-client' }, command)).toBe(false);
    expect(service.admit(principal, command)).toBe(true);
    now += 60_000; // The old strict expiration comparison has not removed the other keys yet.
    expect(service.admit({ ...principal, client_id: 'new-client' }, command)).toBe(false);
    expect(service.admit(principal, command)).toBe(true);
    now++;
    expect(service.admit({ ...principal, client_id: 'new-client' }, command)).toBe(true);
    expect(state.storage.sql.exec("SELECT admission_keys FROM central_governance_meta").one()).toEqual({ admission_keys: 3 });
  });
});

it("Central receipt counts roll back failures and retain the same timestamp ordering", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    let now = 1_000_000; seedGovernanceV1(state.storage, now);
    const service = new CentralGovernance(state.storage, () => undefined, () => now); service.list();
    state.storage.sql.exec("CREATE TRIGGER reject_count BEFORE UPDATE OF receipt_count ON central_governance_meta BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    now += LIMITS.retention_ms + 1;
    expect(service.record(principal, command, { state: 'completed', operation_state: 'completed' }).audit_status).toBe('unavailable');
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM central_receipts_v1").one()).toEqual({ count: LIMITS.receipts });
    state.storage.sql.exec("DROP TRIGGER reject_count");
    const ids = Array.from({ length: 3 }, () => service.record(principal, command, { state: 'completed', operation_state: 'completed' }).request_id).sort().reverse();
    expect(service.list().map(row => row.request_id)).toEqual(ids);
    expect(state.storage.sql.exec("SELECT receipt_count FROM central_governance_meta").one()).toEqual({ receipt_count: 3 });
  });
});

it("failed Central counter migration restores the original schema and can retry", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    const now = 1_000_000; seedGovernanceV1(state.storage, now);
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const spy = vi.spyOn(state.storage.sql, 'exec').mockImplementation((query: string, ...args: any[]) => {
      if (query.startsWith('UPDATE central_governance_meta SET schema_version=2')) throw new Error('synthetic migration failure');
      return original(query, ...args);
    });
    const service = new CentralGovernance(state.storage, () => undefined, () => now);
    try { expect(() => service.list()).toThrow('synthetic migration failure'); }
    finally { spy.mockRestore(); }
    expect(state.storage.sql.exec('SELECT * FROM central_governance_meta').one()).toEqual({ id: 1, schema_version: 1 });
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('central_admission_expiry_v2','central_receipt_time_v2')").toArray()).toEqual([]);
    expect(service.list()).toHaveLength(50);
    expect(service.admit(principal, command)).toBe(true);
    expect(state.storage.sql.exec('SELECT admission_keys,receipt_count FROM central_governance_meta').one()).toEqual({ admission_keys: 2, receipt_count: LIMITS.receipts });
  });
});
it("Central budgets persist across owner reconstruction and recover without timers", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    let now = 1_000_000; const schema = new CentralSchema(state.storage);
    const create = () => new CentralGovernance(state.storage, () => schema.initialize(), () => now), service = create();
    for (let n = 0; n < 30; n++) expect(service.admit(principal, command)).toBe(true);
    expect(create().admit(principal, command)).toBe(false);
    expect(service.admit({ ...principal, client_id: 'client-b' }, command)).toBe(true);
    now += 60_001; expect(service.admit(principal, command)).toBe(true);
  });
});
it.each(["client", "profile", "cooldown"] as const)("Central %s rejection stays read-only within its active window after reconstruction", async limit => {
  await runInDurableObject(owner(), (_instance, state) => {
    let now = 1_000_000;
    const create = () => {
      const schema = new CentralSchema(state.storage);
      return new CentralGovernance(state.storage, () => schema.initialize(), () => now);
    };
    const service = create();
    const attempts = limit === "client" ? LIMITS.calls_per_minute : limit === "profile" ? LIMITS.profile_calls_per_minute : LIMITS.failures;
    for (let n = 0; n < attempts; n++) {
      const caller = limit === "profile" ? { ...principal, client_id: `profile-budget-${n}` } : principal;
      expect(service.admit(caller, command)).toBe(true);
      if (limit === "cooldown") expect(service.record(caller, command, { state: "failed", code: "upstream_unavailable", operation_state: "unknown" }).audit_status).toBe("recorded");
    }
    const receipts = service.list();
    const original = state.storage.sql.exec.bind(state.storage.sql);
    let written = 0;
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      const cursor = original(query, ...args);
      written += cursor.rowsWritten;
      return cursor;
    });
    try {
      // Rejected retries within an active window must not change storage,
      // including schema checks after both storage adapters are rebuilt.
      for (let n = 0; n < 20; n++) {
        expect(service.admit(principal, command)).toBe(false);
        expect(create().admit(principal, command)).toBe(false);
      }
      expect(written).toBe(0);
      expect(service.list()).toEqual(receipts);
      now += 60_001;
      expect(create().admit(principal, command)).toBe(true);
      expect(written).toBeGreaterThan(0);
    } finally { spy.mockRestore(); }
  });
});
it("Central cooldown isolates profiles, receipts omit payloads, and history faults do not replay", async () => {
  await runInDurableObject(owner(), (_instance, state) => {
    let now = 1_000_000; const schema = new CentralSchema(state.storage), service = new CentralGovernance(state.storage, () => schema.initialize(), () => now);
    for (let n = 0; n < 3; n++) {
      expect(service.admit(principal, command)).toBe(true);
      expect(service.record(principal, command, { state: 'failed', code: 'upstream_unavailable', operation_state: 'unknown' }).audit_status).toBe('recorded');
    }
    expect(service.admit(principal, command)).toBe(false);
    expect(service.admit(principal, { profile_id: 'profile-b' })).toBe(true);
    now += 30_001; expect(service.admit(principal, command)).toBe(true);
    const payload = { ...command, arguments: { token: 'DO_NOT_STORE' } };
    service.record(principal, payload, { state: 'completed', operation_state: 'completed' });
    expect(JSON.stringify(service.list())).not.toContain('DO_NOT_STORE');
    expect(service.list()[0]).not.toHaveProperty('runner_id');
    service.record(principal, command, { state: 'failed', operation_state: 'unknown', code: 'DO_NOT_STORE' });
    expect(JSON.stringify(service.list())).not.toContain('DO_NOT_STORE');
    expect(service.list().some(row => row.code === 'result_unconfirmed')).toBe(true);
    state.storage.sql.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON central_receipts_v1 BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    expect(service.record(principal, command, { state: 'completed', operation_state: 'completed' }).audit_status).toBe('unavailable');
    now += 86_400_001; expect(service.list()).toEqual([]);
  });
});
