import { env, SELF, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { PackedJobHistory } from "../src/job-history-store.js";
import { historyLifecycleReader } from "../src/platform/history-lifecycle.js";
import { parseHistoryLifecycles } from "../src/contracts/history-lifecycle.js";
import { DEFAULT_JOB_HISTORY } from "../src/job-history-settings.js";
import { RegistryDO } from "../src/registry.js";
import { internalHeaders } from "../src/security.js";
import type { WorkerEnv } from "../src/platform/env.js";
import type { JobMetadata } from "@aloneio/runmesh-protocol";

const workerEnv = env as unknown as WorkerEnv;
const db = workerEnv.HISTORY_DB!;
const day = 86_400_000;
const settings = { ...DEFAULT_JOB_HISTORY, mode: "immediate" as const };
const recordAll = (jobs: readonly JobMetadata[]) => new Set(jobs.map(job => job.job_id));
const job = (id: string, runnerId: string, now: number): JobMetadata => ({ job_id: id, runner_id: runnerId, workspace_id: "workspace", status: "running", created_at_ms: now, updated_at_ms: now });
const stored = (ns: string) => db.prepare("SELECT runner_id,lifecycle_id,retired_at_ms,retention_days,jobs_json,revision FROM runmesh_job_snapshots_v1 WHERE namespace=? ORDER BY snapshot_id").bind(ns).all<{ runner_id: string; lifecycle_id: string; retired_at_ms: number | null; retention_days: number; jobs_json: string; revision: number }>();

it("retires a deleted Runner lifecycle after its retention window and preserves the replacement's empty policy fence", async () => {
  const id = `history-life-${crypto.randomUUID()}`, ns = crypto.randomUUID(), now = Date.now();
  const store = new PackedJobHistory(db, ns), reader = historyLifecycleReader(workerEnv);
  const admin = (path: string, input: object) => SELF.fetch(`https://worker.test/admin/runners${path}`, {
    method: "POST", headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const add = () => admin("", { runner_id: id, token: `token-${crypto.randomUUID()}`, execution_mode: "dedicated_user" });
  expect((await add()).status).toBe(200);
  const lifecycle = (await reader([id])).get(id)!;
  expect(lifecycle).toEqual(expect.any(String));
  await store.merge(id, lifecycle, [job("running", id, now)], () => settings, recordAll, now);
  await store.cleanup(reader);
  expect((await stored(ns)).results[0]?.retired_at_ms).toBeNull();
  expect((await admin(`/${id}/delete`, { confirmation: id })).status).toBe(204);
  expect((await reader([id])).get(id)).toBeNull();
  expect((await add()).status).toBe(200);
  const replacement = (await reader([id])).get(id)!;
  expect(replacement).not.toBe(lifecycle);
  await store.setRetention(id, replacement, () => settings);
  const retiredAt = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(retiredAt);
  try {
    await store.cleanup(reader);
    expect((await stored(ns)).results.map(row => row.retired_at_ms)).toEqual([retiredAt, null]);
    expect(await store.merge(id, lifecycle, [job("late", id, retiredAt)], () => settings, recordAll)).toMatchObject({ recorded: false });
    await store.setRetention(id, lifecycle, () => ({ ...settings, retention_days: 1 }));
    expect((await stored(ns)).results[0]?.retention_days).toBe(7);
    clock.mockReturnValue(retiredAt + 7 * day - 1);
    await store.cleanup(reader);
    expect((await stored(ns)).results).toHaveLength(2);
    clock.mockReturnValue(retiredAt + 7 * day);
    await store.cleanup(reader);
    expect((await stored(ns)).results).toEqual([expect.objectContaining({ lifecycle_id: replacement, retired_at_ms: null, jobs_json: "[]" })]);
    expect((await store.merge(id, replacement, [job("new", id, Date.now())], () => settings, recordAll)).recorded).toBe(true);
  } finally { clock.mockRestore(); }
});

it("bounds retirement reconciliation and reclaims legacy orphan rows without adding Registry writes", async () => {
  const ns = crypto.randomUUID(), now = Date.now(), store = new PackedJobHistory(db, ns);
  for (let i = 0; i < 42; i++) await store.merge(`r-${i}`, `retired-lifecycle-${i}`, [job(`j-${i}`, `r-${i}`, now)], () => settings, recordAll, now);
  const batches: number[] = [];
  const reader = async (ids: readonly string[]) => { batches.push(ids.length); return new Map(ids.map(id => [id, null])); };
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 365 * day);
  try {
    for (let i = 0; i < 3; i++) await store.cleanup(reader);
    expect(batches).toEqual([20, 20, 2]);
    expect((await stored(ns)).results).toHaveLength(42);
    clock.mockReturnValue(now + 372 * day);
    for (let i = 0; i < 3; i++) await store.cleanup(reader);
    expect((await stored(ns)).results).toHaveLength(0);
    expect(batches).toEqual([20, 20, 2]);
  } finally { clock.mockRestore(); }
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  // Warm schema first, then measure the public signed GET; it consumes no nonce.
  await historyLifecycleReader(workerEnv)(["missing-runner"]);
  await runInDurableObject(registry, async (_instance, state) => {
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const cursors: { rowsWritten: number }[] = [];
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => {
      const cursor = original(query, ...args); cursors.push(cursor); return cursor;
    });
    try {
      const path = "/history/lifecycles?runner_id=missing-runner";
      const response = await _instance.fetch(new Request(`https://registry.internal${path}`, { headers: await internalHeaders(env.INTERNAL_CONTROL_SECRET, "GET", path, "") }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([{ runner_id: "missing-runner", lifecycle_id: null }]);
      expect(cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(0);
    } finally { spy.mockRestore(); }
  });
});

it("continues terminal expiry but preserves active and empty current rows during authority failure or incomplete replies", async () => {
  const ns = crypto.randomUUID(), now = Date.now(), store = new PackedJobHistory(db, ns);
  await store.merge("active", "current-lifecycle", [job("active", "active", now), { ...job("done", "active", now), status: "succeeded" }], () => settings, recordAll, now);
  await store.setRetention("empty", "current-lifecycle", () => settings);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 365 * day);
  try {
    await store.cleanup(async () => { throw new Error("Registry outage"); });
    await store.cleanup(async () => new Map([["active", null]]));
    const rows = (await stored(ns)).results;
    expect(rows.map(row => row.retired_at_ms)).toEqual([null, null]);
    expect(JSON.parse(rows[0]!.jobs_json).map((value: JobMetadata) => value.job_id)).toEqual(["active"]);
    expect(rows[1]!.jobs_json).toBe("[]");
  } finally { clock.mockRestore(); }
});

it("does not let a stale cleanup retire a row updated during its Registry observation", async () => {
  const ns = crypto.randomUUID(), now = Date.now(), store = new PackedJobHistory(db, ns);
  await store.merge("r", "retired-lifecycle", [job("old", "r", now)], () => settings, recordAll, now);
  await store.cleanup(async ids => {
    await store.merge("r", "retired-lifecycle", [job("new", "r", now + 1)], () => settings, recordAll, now + 1);
    return new Map(ids.map(id => [id, null]));
  });
  expect((await stored(ns)).results[0]?.retired_at_ms).toBeNull();
  expect((await store.list("r", "retired-lifecycle", settings)).jobs).toHaveLength(2);
  await store.cleanup(async ids => new Map(ids.map(id => [id, null])));
  expect((await stored(ns)).results[0]?.retired_at_ms).toEqual(expect.any(Number));
});

it("migrates an existing snapshot table across concurrent store initialization without changing retained jobs", async () => {
  const table = "history_migration_" + crypto.randomUUID().replaceAll("-", ""), ns = "migration", now = Date.now();
  const database = { prepare: (query: string) => db.prepare(query.replaceAll("runmesh_job_snapshots_v1", table).replaceAll("runmesh_job_cleanup_v1", table + "_cursor")), batch: db.batch.bind(db) } as D1Database;
  await db.prepare(`CREATE TABLE ${table} (snapshot_id INTEGER PRIMARY KEY,namespace TEXT NOT NULL,runner_id TEXT NOT NULL,lifecycle_id TEXT NOT NULL,jobs_json TEXT NOT NULL,updated_at_ms INTEGER NOT NULL,revision INTEGER NOT NULL,retention_days INTEGER NOT NULL,UNIQUE(namespace,runner_id,lifecycle_id))`).run();
  const legacy = job("legacy", "r", now);
  await db.prepare(`INSERT INTO ${table} VALUES (1,?,'r','legacy-lifecycle',?,?,4,7)`).bind(ns, JSON.stringify([legacy]), now).run();
  const a = new PackedJobHistory(database, ns), b = new PackedJobHistory(database, ns);
  const results = await Promise.all([a.list("r", "legacy-lifecycle", settings), b.list("r", "legacy-lifecycle", settings)]);
  for (const result of results) expect(result.jobs).toEqual([legacy]);
  expect(await db.prepare(`SELECT revision,retired_at_ms FROM ${table}`).first()).toEqual({ revision: 4, retired_at_ms: null });
});

it.each(["upload", "retention"] as const)("rejects a delayed %s write after another instance marks retirement", async action => {
  const ns = crypto.randomUUID(), now = Date.now(), initial = new PackedJobHistory(db, ns);
  await initial.merge("r", "retired-lifecycle", [job("original", "r", now)], () => settings, recordAll, now);
  let release!: () => void, reached!: () => void, armed = false, paused = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { reached = resolve; });
  const prefix = action === "upload" ? "UPDATE runmesh_job_snapshots_v1 SET jobs_json=" : "UPDATE runmesh_job_snapshots_v1 SET retention_days=";
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => ({
    bind: (...args: any[]) => wrap(statement.bind(...args), query), first: statement.first.bind(statement), all: statement.all.bind(statement),
    run: async () => { if (armed && !paused && query.startsWith(prefix)) { paused = true; reached(); await gate; } return statement.run(); },
  }) as D1PreparedStatement;
  const delayed = new PackedJobHistory({ prepare: (query: string) => wrap(db.prepare(query), query), batch: db.batch.bind(db) } as D1Database, ns);
  await delayed.list("r", "retired-lifecycle", settings);
  armed = true;
  const pending = action === "upload" ? delayed.merge("r", "retired-lifecycle", [job("late", "r", now + 1)], () => settings, recordAll, now + 1)
    : delayed.setRetention("r", "retired-lifecycle", () => ({ ...settings, retention_days: 1 }));
  await waiting;
  try { await initial.cleanup(async ids => new Map(ids.map(id => [id, null]))); }
  finally { release(); }
  await pending;
  const row = (await stored(ns)).results[0]!;
  expect(row.retired_at_ms).toEqual(expect.any(Number));
  expect(row.retention_days).toBe(7);
  expect(JSON.parse(row.jobs_json).map((value: JobMetadata) => value.job_id)).toEqual(["original"]);
});

it.each([[], [{ runner_id: "a", lifecycle_id: null }], [{ runner_id: "a", lifecycle_id: null }, { runner_id: "a", lifecycle_id: null }], [{ runner_id: "a", lifecycle_id: null }, { runner_id: "b", lifecycle_id: "bad" }]])("rejects incomplete or malformed authority replies: %j", reply => {
  expect(parseHistoryLifecycles(reply, ["a", "b"])).toBeUndefined();
});

it("rejects unsigned lookup, oversized batches and incomplete transport responses", async () => {
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  expect((await registry.fetch(new Request("https://registry.internal/history/lifecycles?runner_id=a"))).status).toBe(404);
  const tooMany = "/history/lifecycles?" + Array.from({ length: 21 }, (_, i) => `runner_id=r-${i}`).join("&");
  expect((await registry.fetch(new Request(`https://registry.internal${tooMany}`, { headers: await internalHeaders(env.INTERNAL_CONTROL_SECRET, "GET", tooMany, "") }))).status).toBe(400);
  const spy = vi.spyOn(RegistryDO.prototype, "fetch").mockImplementation(async () => Response.json([{ runner_id: "a", lifecycle_id: null }]));
  try { await expect(historyLifecycleReader(workerEnv)(["a", "b"])).rejects.toThrow("snapshot unavailable"); }
  finally { spy.mockRestore(); }
});
