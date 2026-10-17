import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { PackedJobHistory } from "../src/job-history-store.js";
import { DEFAULT_JOB_HISTORY } from "../src/job-history-settings.js";

const db = (env as unknown as { HISTORY_DB: D1Database }).HISTORY_DB;
afterEach(() => vi.restoreAllMocks());
function isolated() {
  const table = `history_${crypto.randomUUID().replaceAll("-", "")}`, index = `${table}_scan`, cursor = `${table}_cursor`;
  const statements: string[] = []; let failIndex = false;
  const database = { prepare: (query: string) => {
    statements.push(query);
    if (failIndex && query.startsWith("CREATE INDEX")) throw new Error("synthetic optional index failure");
    return db.prepare(query.replaceAll("runmesh_job_snapshots_v1", table).replaceAll("runmesh_job_cleanup_v1", cursor + "_legacy").replaceAll("runmesh_job_cleanup_v2", cursor).replaceAll("runmesh_job_scan_v1", index));
  } } as D1Database;
  const store = () => new PackedJobHistory(database, "fixture");
  return { table, index, cursor, database, statements, store, failIndex: (value: boolean) => { failIndex = value; } };
}

it("repairs only a missing scan index and current schema initialization performs zero DDL", async () => {
  const f = isolated();
  await f.store().list("r", "life", DEFAULT_JOB_HISTORY);
  await db.prepare(`INSERT INTO ${f.table} (namespace,runner_id,lifecycle_id,jobs_json,updated_at_ms,revision,retention_days) VALUES ('fixture','r','life','[]',42,7,7)`).run();
  const before = await db.prepare(`SELECT * FROM ${f.table}`).first();
  await db.prepare(`DROP INDEX ${f.index}`).run();
  f.statements.length = 0;
  await f.store().list("r", "life", DEFAULT_JOB_HISTORY);
  expect(f.statements.filter(sql => /^(CREATE|ALTER|DROP)/.test(sql))).toEqual(["CREATE INDEX IF NOT EXISTS runmesh_job_scan_v1 ON runmesh_job_snapshots_v1(namespace,snapshot_id)"]);
  expect(await db.prepare(`SELECT * FROM ${f.table}`).first()).toEqual(before);
  expect(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").bind(f.index).first()).not.toBeNull();
  f.statements.length = 0;
  await Promise.all([f.store().list("r", "life", DEFAULT_JOB_HISTORY), f.store().list("r", "life", DEFAULT_JOB_HISTORY)]);
  expect(f.statements.filter(sql => /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)/.test(sql))).toEqual([]);
});

it("bounds failed optional index repair attempts without disabling reads", async () => {
  const f = isolated(), now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
  f.failIndex(true);
  expect((await f.store().list("r", "life", DEFAULT_JOB_HISTORY)).jobs).toEqual([]);
  f.statements.length = 0;
  expect((await f.store().list("r", "life", DEFAULT_JOB_HISTORY)).jobs).toEqual([]);
  expect(f.statements.filter(sql => sql.startsWith("CREATE INDEX"))).toEqual([]);
  f.failIndex(false); clock.mockReturnValue(now + 900_001);
  await f.store().list("r", "life", DEFAULT_JOB_HISTORY);
  expect(f.statements.filter(sql => sql.startsWith("CREATE INDEX"))).toHaveLength(1);
});

it("detects a wrong index definition without rebuilding data", async () => {
  const f = isolated();
  await f.store().list("r", "life", DEFAULT_JOB_HISTORY);
  await db.prepare(`DROP INDEX ${f.index}`).run();
  await db.prepare(`CREATE INDEX ${f.index} ON ${f.table}(runner_id)`).run();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  f.statements.length = 0;
  await f.store().list("r", "life", DEFAULT_JOB_HISTORY);
  expect(warning).toHaveBeenCalledWith("job_history_scan_index_mismatch");
  expect(f.statements.filter(sql => /^(CREATE|ALTER|DROP)/.test(sql))).toEqual([]);
});

it("concurrently migrates snapshots while retaining rollback-compatible legacy cursors", async () => {
  const f = isolated();
  await db.prepare(`CREATE TABLE ${f.table} (snapshot_id INTEGER PRIMARY KEY,namespace TEXT NOT NULL,runner_id TEXT NOT NULL,lifecycle_id TEXT NOT NULL,jobs_json TEXT NOT NULL,updated_at_ms INTEGER NOT NULL,revision INTEGER NOT NULL,retention_days INTEGER NOT NULL,UNIQUE(namespace,runner_id,lifecycle_id))`).run();
  await db.prepare(`CREATE TABLE ${f.cursor}_legacy (namespace TEXT PRIMARY KEY,cursor INTEGER NOT NULL)`).run();
  await db.prepare(`INSERT INTO ${f.cursor}_legacy VALUES ('fixture',19)`).run();
  await db.prepare(`INSERT INTO ${f.table} VALUES (1,'fixture','r','life','[]',42,7,7)`).run();
  await Promise.all([f.store().list("r", "life", DEFAULT_JOB_HISTORY), f.store().list("r", "life", DEFAULT_JOB_HISTORY)]);
  expect(await db.prepare(`SELECT revision,retired_at_ms,corrupt_revision,corrupt_detected_at_ms,corrupt_reason FROM ${f.table}`).first()).toEqual({ revision: 7, retired_at_ms: null, corrupt_revision: null, corrupt_detected_at_ms: null, corrupt_reason: null });
  expect(await db.prepare(`SELECT * FROM ${f.cursor}_legacy`).first()).toEqual({ namespace: "fixture", cursor: 19 });
  // The legacy implicit-column write must still work after upgrading.
  await db.prepare(`INSERT INTO ${f.cursor}_legacy VALUES ('rollback',23)`).run();
  expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${f.cursor}`).first()).toEqual({ n: 0 });
});
