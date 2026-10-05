import { env } from "cloudflare:test";
import { expect,it,vi } from "vitest";
import { PackedJobHistory,JobHistoryUnavailableError } from "../src/job-history-store.js";
import { DEFAULT_JOB_HISTORY } from "../src/job-history-settings.js";
import { parseJobHistorySettings } from "@aloneio/runmesh-protocol";
import type { JobHistorySettings } from "@aloneio/runmesh-protocol";
const db=(env as unknown as {HISTORY_DB:D1Database}).HISTORY_DB;
const settings={...DEFAULT_JOB_HISTORY,mode:"immediate" as const};
const make=(id:string,t=Date.now(),status="succeeded") => ({job_id:id,runner_id:"r",workspace_id:"w",status,created_at_ms:t,updated_at_ms:t}) as any;

function pausedWrite(namespace: string, matches: (sql: string) => boolean) {
  let armed = false, paused = false, release!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => ({
    bind: (...args: any[]) => wrap(statement.bind(...args), sql),
    first: statement.first.bind(statement), all: statement.all.bind(statement),
    run: async () => {
      if (armed && !paused && matches(sql)) { paused = true; reached(); await gate; }
      return statement.run();
    },
  }) as D1PreparedStatement;
  const store = new PackedJobHistory({ prepare: (sql: string) => sql.startsWith("CREATE") ? db.prepare(sql) : wrap(db.prepare(sql), sql), batch: db.batch.bind(db) } as D1Database, namespace);
  return { store, waiting, release, arm: () => { armed = true; } };
}

it.each(["upload", "first-upload", "settings", "settings-aba"] as const)("keeps the latest retention when an earlier %s write is delayed", async scenario => {
  const ns = "retention-order-" + crypto.randomUUID(), now = Date.now();
  let current: JobHistorySettings = { ...settings, retention_days: scenario === "settings-aba" ? 1 : 7 };
  const f = pausedWrite(ns, sql => scenario.startsWith("settings") ? sql.startsWith("UPDATE runmesh_job_snapshots_v1 SET retention_days=")
    : /^(INSERT INTO|UPDATE) runmesh_job_snapshots_v1/.test(sql));
  if (scenario !== "first-upload") await f.store.merge("r", "life", [make("seed", scenario === "upload" ? now - 2 * 86400000 : now)], () => current, now);
  f.arm();
  if (scenario.startsWith("settings")) current = { ...current, retention_days: scenario === "settings-aba" ? 7 : 3 };
  const earlier = scenario.startsWith("settings") ? f.store.setRetention("r", "life", () => current)
    : f.store.merge("r", "life", [make("new", now + 1), make("old", now - 2 * 86400000)], () => current, now + 1);
  await f.waiting;
  current = { ...current, retention_days: 1 };
  let completed = false;
  const latest = f.store.setRetention("r", "life", () => current).then(() => { completed = true; });
  try {
    await f.store.setRetention("independent-runner", "life", () => current);
    // An acknowledgement must account for an older write still able to change
    // this row, including a no-op change back to its currently stored value.
    await Promise.race([latest, new Promise(resolve => setTimeout(resolve, 30))]);
    expect(completed).toBe(false);
  } finally { f.release(); }
  await Promise.all([earlier, latest]);
  expect(await db.prepare("SELECT retention_days FROM runmesh_job_snapshots_v1 WHERE namespace=? AND runner_id='r'").bind(ns).first()).toEqual({ retention_days: 1 });
  if (!scenario.startsWith("settings")) {
    await f.store.cleanup();
    const row = await db.prepare("SELECT jobs_json FROM runmesh_job_snapshots_v1 WHERE namespace=? AND runner_id='r'").bind(ns).first<{jobs_json:string}>();
    expect(JSON.parse(row!.jobs_json).map((job: {job_id:string}) => job.job_id)).toEqual(["new"]);
  }
});

it("retention settings leave the first batched upload due and repeated settings write no rows", async () => {
  const ns = "retention-empty-" + crypto.randomUUID(), store = new PackedJobHistory(db, ns), now = Date.now();
  await store.setRetention("r", "life", () => DEFAULT_JOB_HISTORY);
  const before = await db.prepare("SELECT revision,updated_at_ms FROM runmesh_job_snapshots_v1 WHERE namespace=?").bind(ns).first();
  expect(before).toEqual({ revision: 1, updated_at_ms: 0 });
  await store.setRetention("r", "life", () => DEFAULT_JOB_HISTORY);
  expect(await db.prepare("SELECT revision,updated_at_ms FROM runmesh_job_snapshots_v1 WHERE namespace=?").bind(ns).first()).toEqual(before);
  expect(await store.merge("r", "life", [make("first", now)], () => DEFAULT_JOB_HISTORY, now)).toMatchObject({ recorded: true, updated_at_ms: now });
});

it.each(["off", "interval", "removed"] as const)("rechecks %s settings after the D1 read before recording a snapshot", async change => {
  const ns = "retention-current-" + crypto.randomUUID(), now = Date.now();
  let current: JobHistorySettings | undefined = settings;
  const initial = new PackedJobHistory(db, ns);
  await initial.merge("r", "life", [make("first", now)], () => current, now);
  let changeOnRead = false;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => ({
    bind: (...args: any[]) => wrap(statement.bind(...args), sql), all: statement.all.bind(statement), run: statement.run.bind(statement),
    first: async () => {
      const row = await statement.first();
      if (changeOnRead && sql.startsWith("SELECT jobs_json")) current = change === "removed" ? undefined
        : { ...settings, mode: change === "off" ? "off" : "batched", interval_seconds: 300 };
      return row;
    },
  }) as D1PreparedStatement;
  const store = new PackedJobHistory({ prepare: (sql: string) => wrap(db.prepare(sql), sql), batch: db.batch.bind(db) } as D1Database, ns);
  changeOnRead = true;
  expect(await store.merge("r", "life", [make("later", now + 1)], () => current, now + 1)).toMatchObject({ recorded: false });
  expect((await initial.list("r", "life", settings)).jobs.map(job => job.job_id)).toEqual(["first"]);
});

it("the next upload applies current retention after a settings write outage", async () => {
  const ns = "retention-recovery-" + crypto.randomUUID(), now = Date.now();
  let current: JobHistorySettings = { ...settings, retention_days: 7 }, unavailable = false;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const guarded = { prepare: (sql: string) => {
    if (unavailable && sql.startsWith("UPDATE runmesh_job_snapshots_v1 SET retention_days=")) throw new Error("temporary D1 write outage");
    return db.prepare(sql);
  }, batch: db.batch.bind(db) } as D1Database;
  const store = new PackedJobHistory(guarded, ns);
  try {
    await store.merge("r", "life", [make("expired", now - 2 * 86400000)], () => current, now);
    current = { ...current, retention_days: 1 }; unavailable = true;
    await expect(store.setRetention("r", "life", () => current)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
    unavailable = false; clock.mockReturnValue(now + 900001);
    expect(await store.merge("r", "life", [make("new", now + 900001)], () => current)).toMatchObject({ recorded: true });
    const row = await db.prepare("SELECT retention_days,jobs_json FROM runmesh_job_snapshots_v1 WHERE namespace=?").bind(ns).first<{ retention_days: number; jobs_json: string }>();
    expect(row?.retention_days).toBe(1); expect(JSON.parse(row!.jobs_json).map((job: {job_id: string}) => job.job_id)).toEqual(["new"]);
  } finally { clock.mockRestore(); }
});

it("stores a multi-Job batch in one row instead of one row per Job",async () => {
  let writes=0;
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement => ({
    bind:(...args:any[]) => wrap(statement.bind(...args)),
    first:statement.first.bind(statement),all:statement.all.bind(statement),
    run:async () => { const result=await statement.run(); writes+=result.meta.rows_written; return result; },
  }) as D1PreparedStatement;
  const measured={prepare:(sql:string)=>sql.startsWith("CREATE") ? db.prepare(sql) : wrap(db.prepare(sql)),batch:db.batch.bind(db)} as D1Database;
  const store=new PackedJobHistory(measured,`cost-${crypto.randomUUID()}`),now=Date.now();
  await store.merge("r","life",[make("j",now)],()=>settings,now);
  writes=0; await store.merge("r","life",[make("j",now+1)],()=>settings,now+1); const single=writes;
  writes=0; await store.merge("r","life",Array.from({length:100},(_,i)=>make(`n-${i}`,now+2+i)),()=>settings,now+102);
  expect(writes).toBe(single); expect(writes).toBeLessThanOrEqual(2);
  console.log(JSON.stringify({scenario:"packed_d1_job_updates",single_job_rows_written:single,batch_jobs:100,batch_rows_written:writes}));
  expect((await store.list("r","life",settings,{limit:10})).jobs).toHaveLength(10);
  expect((await store.list("r","life",settings,{limit:1000})).jobs).toHaveLength(100);
});

it("the interval guard survives reconstruction and unchanged snapshots produce no writes",async () => {
  const ns=`guard-${crypto.randomUUID()}`,now=Date.now(),store=new PackedJobHistory(db,ns);
  expect((await store.merge("r","life",[make("j",now)],()=>DEFAULT_JOB_HISTORY,now)).recorded).toBe(true);
  const fresh=new PackedJobHistory(db,ns);
  expect(await fresh.merge("r","life",[make("new",now+1)],()=>DEFAULT_JOB_HISTORY,now+1)).toMatchObject({recorded:false,deferred:true});
  expect((await fresh.list("r","life",settings)).jobs.map((j)=>j.job_id)).toEqual(["j"]);
  expect(await fresh.merge("r","life",[make("j",now)],()=>DEFAULT_JOB_HISTORY,now+301000)).toMatchObject({recorded:false});
});

it("bounded cleanup expires terminal Jobs but preserves active Jobs",async () => {
  const ns=`expiry-${crypto.randomUUID()}`,now=Date.now(),store=new PackedJobHistory(db,ns);
  await store.merge("r","life",[make("done",now),make("running",now,"running")],()=>settings,now);
  await store.setRetention("r","life",()=>({...settings,retention_days:1}));
  const clock=vi.spyOn(Date,"now").mockReturnValue(now+2*86400000);
  try {
    expect((await store.list("r","life",{...settings,retention_days:1})).jobs.map((j)=>j.job_id)).toEqual(["running"]);
    await store.cleanup();
    const row=await db.prepare("SELECT jobs_json FROM runmesh_job_snapshots_v1 WHERE namespace=?").bind(ns).first<{jobs_json:string}>();
    expect(JSON.parse(row!.jobs_json)).toHaveLength(1);
  } finally {clock.mockRestore();}
});

it("concurrent merges are fenced by revision and never lose distinct Jobs",async () => {
  const ns=`concurrent-${crypto.randomUUID()}`,now=Date.now(),a=new PackedJobHistory(db,ns),b=new PackedJobHistory(db,ns);
  await a.merge("r","life",[make("seed",now)],()=>settings,now);
  await Promise.all([a.merge("r","life",[make("a",now+1)],()=>settings,now+1),b.merge("r","life",[make("b",now+2)],()=>settings,now+2)]);
  expect(new Set((await a.list("r","life",settings)).jobs.map((j)=>j.job_id))).toEqual(new Set(["seed","a","b"]));
  expect((await a.list("r","replacement",settings)).jobs).toEqual([]);
});

it("disabled mode performs no storage I/O and quota failure never falls back to core SQL",async () => {
  const prepare=vi.fn(()=>{throw new Error("quota exceeded");});
  const store=new PackedJobHistory({prepare} as any,"fault");
  expect(await store.merge("r","life",[make("j")],()=>({...settings,mode:"off"}))).toMatchObject({recorded:false});
  expect(prepare).not.toHaveBeenCalled();
  await expect(store.merge("r","life",[make("j")],()=>settings)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
  const attempts=prepare.mock.calls.length;
  for(let i=0;i<100;i++) await expect(store.list("r","life",settings)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
  expect(prepare).toHaveBeenCalledTimes(attempts);
});

it("settings reject malformed values instead of accepting unlimited history",()=>{
  expect(parseJobHistorySettings(DEFAULT_JOB_HISTORY)).toEqual(DEFAULT_JOB_HISTORY);
  for(const value of [{...settings,interval_seconds:1},{...settings,retention_days:999},{...settings,local_retention_days:-1},{...settings,mode:"unknown"}]) expect(parseJobHistorySettings(value)).toBeUndefined();
});


it("daily quota cooldown lasts until the UTC reset without repeated reads or retention writes", async () => {
  const now = Date.UTC(2026, 8, 14, 12);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let unavailable = true, attempts = 0;
  const guarded = {
    prepare(query: string) { attempts++; if (unavailable) throw new Error("daily rows_read limit exceeded"); return db.prepare(query); },
    batch: db.batch.bind(db),
  } as D1Database;
  const store = new PackedJobHistory(guarded, `reset-${crypto.randomUUID()}`);
  try {
    await expect(store.merge("r", "life", [make("j")], () => settings)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
    const failedAttempts = attempts;
    clock.mockReturnValue(now + 2 * 3600000);
    for (let i = 0; i < 1000; i++) await expect(store.list("r", "life", settings)).rejects.toBeInstanceOf(JobHistoryUnavailableError);
    await expect(store.setRetention("r", "life", () => ({...settings,retention_days:1}))).rejects.toBeInstanceOf(JobHistoryUnavailableError);
    await store.cleanup();
    expect(attempts).toBe(failedAttempts);
    unavailable = false;
    clock.mockReturnValue(Date.UTC(2026, 8, 15) + 30001);
    expect((await store.merge("r", "life", [make("recovered")], () => settings)).recorded).toBe(true);
    expect((await store.list("r", "life", settings)).jobs.map((job) => job.job_id)).toEqual(["recovered"]);
  } finally { clock.mockRestore(); }
});
