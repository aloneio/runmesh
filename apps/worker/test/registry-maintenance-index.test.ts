import { env, runInDurableObject } from "cloudflare:test";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, type RunnerMetadata } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";
import { RegistryDO } from "../src/registry.js";
import { ensureRunnerMaintenanceIndex, registrySchemaIsCurrent } from "../src/registry/schema.js";
import { internalHeaders } from "../src/security.js";

const indexName = "idx_runners_online_heartbeat";
const scoped = () => env.REGISTRY.get(env.REGISTRY.idFromName(`maintenance-index-${crypto.randomUUID()}`));

async function consumeNonce(instance: RegistryDO, now: number): Promise<Response> {
  const path = "/auth/internal-nonces", body = JSON.stringify({ nonce: "a".repeat(64), expires_at_ms: now + 60_000 });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", path, body);
  return instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", body, headers }));
}

async function reconstruct(state: DurableObjectState): Promise<RegistryDO> {
  let startup: Promise<unknown> | undefined;
  const original = state.blockConcurrencyWhile.bind(state);
  const gate = vi.spyOn(state, "blockConcurrencyWhile").mockImplementation(callback => {
    const pending = original(callback); startup = pending; return pending;
  });
  try {
    const instance = new RegistryDO(state, env);
    expect(startup).toBeDefined();
    await startup;
    return instance;
  } finally { gate.mockRestore(); }
}

const deadlineCases: readonly { name: string; runners: readonly (readonly [string, number | null])[]; delay: number }[] = [
  { name: "empty", runners: [], delay: 60_000 },
  { name: "offline and stale only", runners: [["offline", null], ["stale", -500]], delay: 60_000 },
  { name: "online missing heartbeat", runners: [["online", null], ["online", 0]], delay: 1_000 },
  { name: "mixed states", runners: [["offline", -10_000], ["online", 0], ["stale", -5_000], ["online", -500]], delay: 44_500 },
  { name: "duplicate earliest heartbeat", runners: [["online", -500], ["online", 100], ["online", -500]], delay: 44_500 },
  { name: "exact liveness boundary", runners: [["online", -45_000]], delay: 1_000 },
];

it.each(deadlineCases)("preserves the maintenance deadline for $name", async ({ runners, delay }) => {
  await runInDurableObject(scoped(), async (instance, state) => {
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      runners.forEach(([status, offset], index) => {
        state.storage.sql.exec("INSERT INTO runners(runner_id,display_name,token_verifier,state,lifecycle_id,last_heartbeat_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)",
          `r-${index}`, `Runner ${index}`, "synthetic", status, `life-${index}`, offset === null ? null : now + offset, now);
      });
      expect((await consumeNonce(instance, now)).status).toBe(204);
      expect(await state.storage.getAlarm()).toBe(now + delay);
    } finally { clock.mockRestore(); }
  });
});

it("reconstructs an existing store with an indexed constant-size deadline read and no repeated DDL", async () => {
  await runInDurableObject(scoped(), async (_instance, state) => {
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now), sql = state.storage.sql;
    try {
      sql.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
        INSERT INTO runners(runner_id,display_name,token_verifier,state,lifecycle_id,last_heartbeat_ms,updated_at_ms)
        SELECT printf('r-%04d',x), 'Runner', 'synthetic', CASE WHEN x%2=1 THEN 'online' ELSE 'offline' END, printf('life-%04d',x), ?+x, ? FROM n`, now, now);
      sql.exec(`DROP INDEX ${indexName}`);
      expect(registrySchemaIsCurrent(sql)).toBe(true);
      const old = sql.exec<{ next_ms: number }>("SELECT MIN(COALESCE(last_heartbeat_ms, 0) + ?) AS next_ms FROM runners WHERE state = 'online'", 45_000);
      expect(old.one().next_ms).toBe(now + 45_001);
      expect(old.rowsRead).toBeGreaterThanOrEqual(1000);
      const original = sql.exec.bind(sql), reads: { readonly rowsRead: number }[] = [];
      const spy = vi.spyOn(sql, "exec").mockImplementation((query: string, ...args: any[]) => {
        const cursor = original(query, ...args);
        if (query.startsWith("SELECT MIN(COALESCE(last_heartbeat_ms")) reads.push(cursor);
        return cursor;
      });
      let next: RegistryDO;
      try {
        next = await reconstruct(state);
        expect((await consumeNonce(next, now)).status).toBe(204);
        expect(reads).toHaveLength(2);
        expect(reads.every(cursor => cursor.rowsRead <= 2)).toBe(true);
      } finally { spy.mockRestore(); }
      expect(await state.storage.getAlarm()).toBe(now + 45_001);
      expect(sql.exec("SELECT COUNT(*) AS total FROM runners").one().total).toBe(1000);
      expect(sql.exec("SELECT SUM(last_heartbeat_ms-?) AS total FROM runners", now).one().total).toBe(500_500);
      let written = 0;
      const ddl = vi.spyOn(sql, "exec").mockImplementation((query: string, ...args: any[]) => {
        const cursor = original(query, ...args); written += cursor.rowsWritten; return cursor;
      });
      try {
        ensureRunnerMaintenanceIndex(sql);
        ensureRunnerMaintenanceIndex(sql);
        expect(written).toBe(0);
      } finally { ddl.mockRestore(); }
    } finally { clock.mockRestore(); }
  });
});

it("keeps existing data and maintenance available when optional index creation fails", async () => {
  await runInDurableObject(scoped(), async (instance, state) => {
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now), sql = state.storage.sql;
    try {
      expect(instance.registerRunner("preserved", "synthetic", now, undefined, "dedicated_user")).toBe(true);
      sql.exec("UPDATE runners SET state='online', last_heartbeat_ms=? WHERE runner_id='preserved'", now);
      const before = sql.exec("SELECT * FROM runners WHERE runner_id='preserved'").one();
      sql.exec(`DROP INDEX ${indexName}`);
      const original = sql.exec.bind(sql);
      const fault = vi.spyOn(sql, "exec").mockImplementation((query: string, ...args: any[]) => {
        if (query.startsWith(`CREATE INDEX ${indexName}`)) throw new Error("synthetic index storage quota");
        return original(query, ...args);
      });
      try {
        const next = await reconstruct(state);
        expect((await consumeNonce(next, now)).status).toBe(204);
        expect(await state.storage.getAlarm()).toBe(now + 45_000);
      } finally { fault.mockRestore(); }
      expect(sql.exec("SELECT * FROM runners WHERE runner_id='preserved'").one()).toEqual(before);
      expect(sql.exec("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?", indexName).toArray()).toHaveLength(0);
      await reconstruct(state);
      expect(sql.exec("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?", indexName).toArray()).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });
});

it("reports connection, heartbeat and credential revocation results independently of index write counts", async () => {
  await runInDurableObject(scoped(), (instance, state) => {
    const now = Date.now(), id = "indexed-runner", session = "indexed-session";
    expect(instance.registerRunner(id, "a".repeat(64), now, undefined, "dedicated_user")).toBe(true);
    const initial = instance.getRunnerExecutionState(id)!;
    const metadata: RunnerMetadata = { runner_id: id, runner_version: "0.1.8", platform: "linux", architecture: "x64",
      capabilities: { filesystem: true, process_execution: true, workspace_sync: true, pty: false, network_access: false,
        max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } };
    const protocol = { min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION };
    const first = instance.beginConnection(id, metadata, protocol, session, initial.runner.credential_version, now, initial.lifecycle_id);
    expect(first).toBe(1);
    const second = instance.beginConnection(id, metadata, protocol, session, initial.runner.credential_version, now + 1, initial.lifecycle_id);
    expect(second).toBe(2);
    expect(instance.beginConnection(id, metadata, protocol, session, initial.runner.credential_version + 1, now + 2, initial.lifecycle_id)).toBeUndefined();
    const sql = vi.spyOn(state.storage.sql, "exec");
    try {
      expect(instance.recordHeartbeat(id, second!, initial.runner.credential_version, now + 1000, initial.lifecycle_id, session)).toBe(true);
      expect(sql.mock.calls).toHaveLength(1);
    } finally { sql.mockRestore(); }
    expect(instance.recordHeartbeat(id, second!, initial.runner.credential_version, now + 999, initial.lifecycle_id, session)).toBe(true);
    expect(instance.recordHeartbeat(id, first!, initial.runner.credential_version, now + 1001, initial.lifecycle_id, session)).toBe(false);
    expect(instance.createRunnerEnrollment(id, "e".repeat(43), "b".repeat(64), now)).toBeDefined();
    expect(instance.invalidateRunnerCredential(id, now + 2000)).toBe(true);
    expect(state.storage.sql.exec("SELECT state, token_verifier, last_heartbeat_ms FROM runners WHERE runner_id=?", id).one()).toEqual({ state: "offline", token_verifier: "", last_heartbeat_ms: null });
    expect(state.storage.sql.exec("SELECT 1 FROM runner_enrollments WHERE runner_id=?", id).toArray()).toHaveLength(0);
    expect(instance.invalidateRunnerCredential("missing-runner", now + 2000)).toBe(false);
  });
});
