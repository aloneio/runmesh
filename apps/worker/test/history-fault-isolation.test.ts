import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { JobMetadata } from "@aloneio/runmesh-protocol";
import { PackedJobHistory, JobHistoryUnavailableError } from "../src/job-history-store.js";
import { DEFAULT_JOB_HISTORY } from "../src/job-history-settings.js";

const db = (env as unknown as { HISTORY_DB: D1Database }).HISTORY_DB;
const day = 86_400_000;
const settings = { ...DEFAULT_JOB_HISTORY, mode: "immediate" as const, retention_days: 1 as const };
const recordAll = (jobs: readonly JobMetadata[]) => new Set(jobs.map(job => job.job_id));
const job = (id: string, runner = "r", now = Date.now()): JobMetadata => ({
  job_id: id, runner_id: runner, workspace_id: "w", status: "succeeded", created_at_ms: now, updated_at_ms: now,
});
afterEach(() => vi.restoreAllMocks());

it.each(["{", JSON.stringify([{ ...job("bad", "bad"), status: "unsupported" }])])("isolates damaged history without disabling a healthy Runner: %s", async body => {
  const ns = crypto.randomUUID(), store = new PackedJobHistory(db, ns);
  await store.merge("bad", "life", [job("bad", "bad")], () => settings, recordAll);
  await store.merge("good", "life", [job("good", "good")], () => settings, recordAll);
  await db.prepare("UPDATE runmesh_job_snapshots_v1 SET jobs_json=? WHERE namespace=? AND runner_id='bad'").bind(body, ns).run();
  await expect(store.list("bad", "life", settings)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
  expect((await store.list("good", "life", settings)).jobs[0]?.job_id).toBe("good");
  await expect(store.get("bad", "life", "bad", settings)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
  expect((await store.get("good", "life", "good", settings))?.job_id).toBe("good");
});

it.each([0, 10, 19, 20, 21])("continues bounded cleanup past bad row %i across reconstruction", async bad => {
  const ns = crypto.randomUUID(), start = Date.now(), store = new PackedJobHistory(db, ns);
  for (let i = 0; i < 22; i++) await store.merge(`r-${i}`, "life", [job(`j-${i}`, `r-${i}`, start)], () => settings, recordAll, start);
  await db.prepare("UPDATE runmesh_job_snapshots_v1 SET jobs_json='{' WHERE namespace=? AND runner_id=?").bind(ns, `r-${bad}`).run();
  vi.spyOn(Date, "now").mockReturnValue(start + 2 * day);
  for (let i = 0; i < 4; i++) await new PackedJobHistory(db, ns).cleanup();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM runmesh_job_snapshots_v1 WHERE namespace=? AND runner_id<>? AND jobs_json<>'[]'").bind(ns, `r-${bad}`).first<{ n: number }>();
  expect(row?.n).toBe(0);
  expect(await db.prepare("SELECT corrupt_reason FROM runmesh_job_snapshots_v1 WHERE namespace=? AND runner_id=?").bind(ns, `r-${bad}`).first()).toEqual({ corrupt_reason: "invalid_json" });
});

type HistoryRow = { snapshot_id: number; revision: number; jobs_json: string; retired_at_ms: number | null; corrupt_revision: number | null; corrupt_detected_at_ms: number | null; corrupt_reason: string | null };

async function damaged() {
  const ns = crypto.randomUUID(), store = new PackedJobHistory(db, ns), now = Date.now();
  await store.merge("r", "life", [job("before", "r", now)], () => settings, recordAll, now);
  await db.prepare("UPDATE runmesh_job_snapshots_v1 SET jobs_json='{' WHERE namespace=?").bind(ns).run();
  const row = () => db.prepare("SELECT * FROM runmesh_job_snapshots_v1 WHERE namespace=? AND runner_id='r'").bind(ns).first<HistoryRow>();
  return { ns, store, now, row };
}

it("quarantines once, expires only the damaged body, and never reports an empty successful history", async () => {
  const f = await damaged(), clock = vi.spyOn(Date, "now").mockReturnValue(f.now);
  expect(await f.store.cleanup()).toMatchObject({ state: "complete", scanned: 1, quarantined: 1 });
  const first = await f.row();
  expect(first).toMatchObject({ jobs_json: "{", corrupt_reason: "invalid_json", corrupt_detected_at_ms: f.now });
  expect(first?.corrupt_revision).toBe(first?.revision);
  await new PackedJobHistory(db, f.ns).cleanup();
  expect(await f.row()).toEqual(first);
  clock.mockReturnValue(f.now + day);
  await new PackedJobHistory(db, f.ns).cleanup();
  const tombstone = await f.row();
  expect(tombstone).toMatchObject({ jobs_json: "", corrupt_reason: "expired" });
  await expect(f.store.list("r", "life", settings)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
  await expect(f.store.merge("r", "life", [job("new")], () => settings, recordAll)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
  await f.store.cleanup();
  expect(await f.row()).toEqual(tombstone);
});

it("retirement authority still reclaims a damaged deleted lifecycle but incomplete replies do not", async () => {
  const f = await damaged(), clock = vi.spyOn(Date, "now").mockReturnValue(f.now);
  await f.store.cleanup(async () => new Map());
  expect((await f.row())?.retired_at_ms).toBeNull();
  await f.store.cleanup(async ids => new Map(ids.map(id => [id, null])));
  expect((await f.row())?.retired_at_ms).toBe(f.now);
  clock.mockReturnValue(f.now + day);
  await new PackedJobHistory(db, f.ns).cleanup();
  expect(await f.row()).toBeNull();
});

it("rejects invalid input and exhausted optimistic conflicts without opening a dependency circuit", async () => {
  const ns = crypto.randomUUID(), store = new PackedJobHistory(db, ns), now = Date.now();
  await store.merge("r", "life", [job("original", "r", now)], () => settings, recordAll);
  for (const invalid of [{ ...job("bad"), status: "unsupported" }, { ...job("original"), workspace_id: "different" }, job("wrong", "other")]) {
    await expect(store.merge("r", "life", [invalid as JobMetadata], () => settings, recordAll)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
    expect((await store.list("r", "life", settings)).jobs[0]?.job_id).toBe("original");
  }
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => ({
    bind: (...args: unknown[]) => wrap(statement.bind(...args), sql), first: statement.first.bind(statement), all: statement.all.bind(statement),
    run: () => sql.startsWith("UPDATE runmesh_job_snapshots_v1 SET jobs_json=")
      ? Promise.resolve({ success: true, meta: { changes: 0 }, results: [] } as unknown as D1Result) : statement.run(),
  }) as D1PreparedStatement;
  const conflicted = new PackedJobHistory({ prepare: (sql: string) => wrap(db.prepare(sql), sql) } as D1Database, ns);
  await expect(conflicted.merge("r", "life", [job("next", "r", now + 1)], () => settings, recordAll, now + 1)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
  expect((await conflicted.list("r", "life", settings)).jobs[0]?.job_id).toBe("original");
});

it("a failed quarantine write does not commit cursor progress and genuine D1 failure still cools down", async () => {
  const f = await damaged(); let fail = true, calls = 0;
  const clock = vi.spyOn(Date, "now").mockReturnValue(f.now);
  const guarded = { prepare: (sql: string) => {
    calls++;
    if (fail && sql.startsWith("UPDATE runmesh_job_snapshots_v1 SET corrupt_revision=")) throw new Error("synthetic D1 write outage");
    return db.prepare(sql);
  } } as D1Database;
  const store = new PackedJobHistory(guarded, f.ns);
  expect(await store.cleanup()).toMatchObject({ state: "unavailable", cursor_advanced: false });
  expect(await db.prepare("SELECT cursor FROM runmesh_job_cleanup_v2 WHERE namespace=?").bind(f.ns).first()).toBeNull();
  expect((await f.row())?.corrupt_revision).toBeNull();
  fail = false; const previous = calls;
  await expect(store.list("healthy", "life", settings)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
  expect(calls).toBe(previous);
  clock.mockReturnValue(f.now + 900_001);
  expect(await store.cleanup()).toMatchObject({ state: "complete", quarantined: 1 });
  expect((await store.list("healthy", "life", settings)).jobs).toEqual([]);
});

function pauseStatement(matches: (sql: string) => boolean) {
  let release!: () => void, reached!: () => void, paused = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => ({
    bind: (...args: unknown[]) => wrap(statement.bind(...args), sql), first: statement.first.bind(statement), all: statement.all.bind(statement),
    run: async () => { if (!paused && matches(sql)) { paused = true; reached(); await gate; } return statement.run(); },
  }) as D1PreparedStatement;
  return { database: { prepare: (sql: string) => wrap(db.prepare(sql), sql) } as D1Database, waiting, release };
}

it("does not quarantine or overwrite a revision concurrently repaired by an operator", async () => {
  const f = await damaged(), paused = pauseStatement(sql => sql.startsWith("UPDATE runmesh_job_snapshots_v1 SET corrupt_revision="));
  const sweep = new PackedJobHistory(paused.database, f.ns).cleanup();
  await paused.waiting;
  try {
    const original = await f.row();
    await db.prepare("UPDATE runmesh_job_snapshots_v1 SET jobs_json=?,revision=revision+1 WHERE namespace=? AND revision=?")
      .bind(JSON.stringify([job("recovered")]), f.ns, original!.revision).run();
  } finally { paused.release(); }
  expect(await sweep).toMatchObject({ state: "deferred", conflicts: 1, quarantined: 0 });
  expect((await f.store.list("r", "life", settings)).jobs[0]?.job_id).toBe("recovered");
  expect((await f.row())?.corrupt_revision).toBeNull();
});

it("a stale sweep cannot rewind a cursor after another sweep completes a full cycle", async () => {
  const ns = crypto.randomUUID(), store = new PackedJobHistory(db, ns), now = Date.now();
  for (let i = 0; i < 22; i++) await store.merge(`r-${i}`, "life", [job(`j-${i}`, `r-${i}`, now)], () => settings, recordAll, now);
  const paused = pauseStatement(sql => sql.startsWith("INSERT INTO runmesh_job_cleanup_v2"));
  const stale = new PackedJobHistory(paused.database, ns).cleanup();
  await paused.waiting;
  try { await store.cleanup(); await store.cleanup(); }
  finally { paused.release(); }
  expect(await stale).toMatchObject({ state: "deferred", cursor_advanced: false });
  expect(await db.prepare("SELECT cursor,generation FROM runmesh_job_cleanup_v2 WHERE namespace=?").bind(ns).first()).toEqual({ cursor: 0, generation: 2 });
});

it.each([
  ["shape", () => "{}"],
  ["identity", () => JSON.stringify([job("wrong", "another-runner")])],
  ["duplicate", () => JSON.stringify([job("same"), job("same")])],
  ["count", () => JSON.stringify(Array.from({ length: 501 }, (_, i) => job(`j-${i}`)))],
  ["bytes", () => " ".repeat(768 * 1024 + 1)],
] as const)("bounds and isolates %s corruption without exposing payloads", async (_name, body) => {
  const f = await damaged();
  await db.prepare("UPDATE runmesh_job_snapshots_v1 SET jobs_json=? WHERE namespace=?").bind(body(), f.ns).run();
  await expect(f.store.list("r", "life", settings)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
  expect((await f.store.list("healthy", "life", settings)).jobs).toEqual([]);
  expect(await f.store.cleanup()).toMatchObject({ state: "complete", quarantined: 1 });
});

it("retains only safe diagnostic fields and fences manual repair by the observed revision", async () => {
  const f = await damaged(), sentinel = "synthetic-private-payload-must-not-appear";
  await db.prepare("UPDATE runmesh_job_snapshots_v1 SET jobs_json=? WHERE namespace=?").bind(`{"private":"${sentinel}"`, f.ns).run();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await f.store.cleanup();
  expect(JSON.stringify(warning.mock.calls)).not.toContain(sentinel);
  const current = await f.row(), restored = JSON.stringify([job("restored")]);
  const repair = (revision: number) => db.prepare("UPDATE runmesh_job_snapshots_v1 SET jobs_json=?,revision=revision+1,corrupt_revision=NULL,corrupt_detected_at_ms=NULL,corrupt_reason=NULL WHERE namespace=? AND snapshot_id=? AND runner_id='r' AND lifecycle_id='life' AND revision=? AND retired_at_ms IS NULL")
    .bind(restored, f.ns, current!.snapshot_id, revision).run();
  expect((await repair(current!.revision - 1)).meta.changes).toBe(0);
  expect((await repair(current!.revision)).meta.changes).toBe(1);
  expect((await f.store.list("r", "life", settings)).jobs[0]?.job_id).toBe("restored");
  expect((await f.row())?.corrupt_reason).toBeNull();
});

it("a delayed quarantine expiry cannot erase a freshly repaired snapshot", async () => {
  const f = await damaged();
  vi.spyOn(Date, "now").mockReturnValue(f.now);
  await f.store.cleanup();
  vi.mocked(Date.now).mockReturnValue(f.now + day);
  const paused = pauseStatement(sql => sql.startsWith("UPDATE runmesh_job_snapshots_v1 SET jobs_json='',corrupt_revision="));
  const sweep = new PackedJobHistory(paused.database, f.ns).cleanup();
  await paused.waiting;
  try {
    const old = await f.row();
    await db.prepare("UPDATE runmesh_job_snapshots_v1 SET jobs_json=?,revision=revision+1,corrupt_revision=NULL,corrupt_detected_at_ms=NULL,corrupt_reason=NULL WHERE namespace=? AND revision=?")
      .bind(JSON.stringify([job("fresh")]), f.ns, old!.revision).run();
  } finally { paused.release(); }
  expect(await sweep).toMatchObject({ state: "deferred", conflicts: 1 });
  expect((await f.store.list("r", "life", settings)).jobs[0]?.job_id).toBe("fresh");
  expect((await f.row())?.corrupt_reason).toBeNull();
});
