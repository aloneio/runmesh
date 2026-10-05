import { env,runInDurableObject } from "cloudflare:test";
import { expect,it,vi, type Mock } from "vitest";
import { RegistryDO } from "../src/registry.js";
import { internalHeaders } from "../src/security.js";
import { DEFAULT_JOB_HISTORY } from "../src/job-history-settings.js";
const db=(env as unknown as {HISTORY_DB:D1Database}).HISTORY_DB;

type Send=(action:string,input:Record<string,unknown>,method?:string)=>Promise<Response>;
async function fixture(test:(instance:RegistryDO,state:DurableObjectState,send:Send,identity:Record<string,unknown>,prepare:Mock<D1Database["prepare"]>)=>Promise<void>, backend: "d1" | "sqlite" = "d1") {
  const stub=env.REGISTRY.get(env.REGISTRY.idFromName(`packed-integration-${crypto.randomUUID()}`));
  await runInDurableObject(stub,async(_instance,state)=>{
    const prepare = vi.fn(db.prepare.bind(db));
    const historyDb = new Proxy(db, { get(target, key) {
      if (key === "prepare") return prepare;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const instance = new RegistryDO(state, { ...env, HISTORY_DB: historyDb, RUNMESH_JOB_HISTORY_BACKEND: backend });
    await state.blockConcurrencyWhile(async () => {});
    const now=Date.now();
    instance.registerRunner("r","a".repeat(64),now,undefined,"dedicated_user");
    instance.createMcpClient({client_id:"c",label:"test",secret_verifier:"b".repeat(64),secret_prefix:"test",scopes:["coding:read","coding:exec"]},now);
    const fence=instance.getRunnerExecutionState("r")!;
    state.storage.sql.exec("UPDATE runners SET state='online',session_id='history-session',last_heartbeat_ms=? WHERE runner_id='r'",now);
    const identity={epoch:fence.runner.connection_epoch,credential_version:fence.runner.credential_version,lifecycle_id:fence.lifecycle_id,session_id:"history-session",now_ms:now};
    const send:Send=async(action,input,method="POST")=>{
      const path=action.startsWith("/")?action:`/runners/r/${action}`,body=method==="GET"?"":JSON.stringify(input);
      return instance.fetch(new Request(`https://registry.internal${path}`,{method,headers:await internalHeaders(env.INTERNAL_CONTROL_SECRET,method,path,body),...(method==="GET"?{}:{body})}));
    };
    await test(instance,state,send,identity,prepare);
  });
}
function sync(identity:Record<string,unknown>,ids=["one","two"]):Record<string,unknown> {
  const now=Date.now();
  return {...identity,message:{type:"runner.sync",protocol_version:2,runner_id:"r",sync_sequence:1,sent_at_ms:now,workspaces:[],jobs:ids.map(job_id=>({job_id,runner_id:"r",workspace_id:"w",status:"succeeded",created_at_ms:now,updated_at_ms:now,created_by_client_id:"c"}))}};
}

it("SQLite acknowledges superseded snapshots without regressing jobs or accepting replaced sessions", async () => {
  await fixture(async (instance, _state, send, identity) => {
    const snapshot = (sequence: number, ids: string[]) => {
      const value = sync(identity, ids);
      return { ...value, message: { ...(value.message as Record<string, unknown>), sync_sequence: sequence,
        extensions: { runmesh_history_ack: true } } };
    };
    expect(await (await send("sync", snapshot(2, ["newer"]))).json()).toEqual({ history_status: "recorded" });
    for (const sequence of [1, 2]) {
      const response = await send("sync", snapshot(sequence, ["superseded"]));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ history_status: "unchanged" });
    }
    expect(instance.getJob("r", "newer")).toBeDefined();
    expect(instance.getJob("r", "superseded")).toBeUndefined();
    expect(instance.getRunner("r")?.state).toBe("online");
    expect((await send("sync", { ...snapshot(1, ["replaced"]), session_id: "replaced-session" })).status).toBe(409);
    instance.setJobHistorySettings("r", { ...DEFAULT_JOB_HISTORY, mode: "off" });
    expect(await (await send("sync", snapshot(3, ["disabled"]))).json()).toEqual({ history_status: "disabled" });
    expect(instance.getJob("r", "disabled")).toBeUndefined();
  }, "sqlite");
});

it("the production archive route stores a packed snapshot without writing core Job rows",async()=>{
  await fixture(async(instance,state,send,identity)=>{
    const spy=vi.spyOn(state.storage.sql,"exec");
    try {
      const response=await send("sync",sync(identity));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({history_status:"recorded"});
      expect(spy.mock.calls.some(([sql])=>/INSERT INTO (jobs|internal_request_nonces)|UPDATE runners/.test(sql))).toBe(false);
    } finally {spy.mockRestore();}
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
    const list=await send("jobs?limit=10",{},"GET"); expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({source:"packed_d1_snapshot",jobs:[{job_id:"two"},{job_id:"one"}]});
    expect(await (await send("sync",sync(identity,["three"]))).json()).toMatchObject({history_status:"deferred"});
    expect(instance.getRunner("r")?.state).toBe("online");
  });
});

it("stale sessions are rejected, and opt-out settings suppress new history",async()=>{
  await fixture(async(instance,state,send,identity,prepare)=>{
    expect((await send("sync",{...sync(identity),session_id:"stale"})).status).toBe(409);
    instance.setJobRecording("c",false,Date.now());
    expect(await (await send("sync",sync(identity))).json()).toMatchObject({history_status:"unchanged"});
    expect((await (await send("jobs?limit=10",{},"GET")).json() as any).jobs).toEqual([]);
    instance.setJobHistorySettings("r",{...DEFAULT_JOB_HISTORY,mode:"off"});
    prepare.mockClear().mockImplementation(()=>{throw new Error("unexpected archive access");});
    expect(await (await send("sync",sync(identity))).json()).toMatchObject({history_status:"disabled"});
    expect(prepare).not.toHaveBeenCalled();
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
  });
});

it("archive failure reports degraded history without changing Runner availability",async()=>{
  await fixture(async(instance,_state,send,identity,prepare)=>{
    prepare.mockImplementation(()=>{throw new Error("synthetic daily read quota exceeded");});
    const response=await send("sync",sync(identity));
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({history_status:"degraded"});
    expect(instance.getRunner("r")?.state).toBe("online");
    expect((await send("jobs?limit=10",{},"GET")).status).toBe(503);
  });
});

it("empty snapshots never open the D1 archive", async () => {
  await fixture(async (instance, state, send, identity,prepare) => {
    prepare.mockImplementation(() => { throw new Error("empty archive must not be opened"); });
    expect(await (await send("sync", sync(identity, []))).json()).toMatchObject({ history_status: "unchanged" });
    expect(prepare).not.toHaveBeenCalled();
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
  });
});

it.each([1, 100])("checks an opted-out batch of %s new Jobs with one snapshot read and no snapshot writes", async count => {
  await fixture(async (instance, _state, send, identity, prepare) => {
    instance.setJobRecording("c", false, Date.now());
    prepare.mockClear();
    expect(await (await send("sync", sync(identity, Array.from({ length: count }, (_, index) => `new-${index}`)))).json())
      .toMatchObject({ history_status: "unchanged" });
    expect(prepare.mock.calls.filter(([sql]) => sql.startsWith("SELECT jobs_json"))).toHaveLength(1);
    expect(prepare.mock.calls.some(([sql]) => /^(INSERT INTO|UPDATE) runmesh_job_snapshots_v1/.test(sql))).toBe(false);
    expect((await (await send("jobs", {}, "GET")).json() as { jobs: unknown[] }).jobs).toEqual([]);
  });
});

it.each(["d1", "sqlite"] as const)("%s updates archived Jobs across opt-out and re-enabling without backfilling unrecorded Jobs", async backend => {
  await fixture(async (_instance, _state, send, identity) => {
    expect((await send("history-settings", { ...DEFAULT_JOB_HISTORY, mode: "immediate" })).status).toBe(200);
    const createdAt = Date.now() - 1000;
    const job = (jobId: string, status: "running" | "succeeded", created = createdAt) => ({
      job_id: jobId, runner_id: "r", workspace_id: "w", status, created_at_ms: created, updated_at_ms: Date.now(), created_by_client_id: "c",
    });
    const upload = async (sequence: number, jobs: ReturnType<typeof job>[]) => {
      const payload = sync(identity, []);
      return send("sync", { ...payload, message: { ...(payload.message as object), sync_sequence: sequence, jobs,
        extensions: { runmesh_history_ack: true } } });
    };
    const list = async () => (await (await send("jobs", {}, "GET")).json() as { jobs: Array<{ job_id: string; status: string }> }).jobs;
    expect((await upload(1, [job("during-off", "running"), job("after-on", "running")])).status).toBe(200);
    expect((await send("/auth/clients/c/recording", { record_jobs: false })).status).toBe(200);
    expect((await upload(2, [job("during-off", "succeeded"), job("unrecorded", "running")])).status).toBe(200);
    expect(await list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_id: "during-off", status: "succeeded" }),
      expect.objectContaining({ job_id: "after-on", status: "running" }),
    ]));
    expect((await list()).some(value => value.job_id === "unrecorded")).toBe(false);
    expect((await send("/auth/clients/c/recording", { record_jobs: true })).status).toBe(200);
    expect((await upload(3, [job("after-on", "succeeded"), job("unrecorded", "succeeded"), job("new-window", "succeeded", Date.now())])).status).toBe(200);
    const result = await list();
    expect(result).toHaveLength(3);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_id: "during-off", status: "succeeded" }),
      expect.objectContaining({ job_id: "after-on", status: "succeeded" }),
      expect.objectContaining({ job_id: "new-window", status: "succeeded" }),
    ]));
  }, backend);
});

it.each(["off", "new-window"])("uses current %s recording preferences after an archive read", async change => {
  await fixture(async (_instance, _state, send, identity, prepare) => {
    expect((await send("history-settings", { ...DEFAULT_JOB_HISTORY, mode: "immediate" })).status).toBe(200);
    const createdAt = Date.now() - 1000;
    const job = (jobId: string, status: string) => ({ job_id: jobId, runner_id: "r", workspace_id: "w", status,
      created_at_ms: createdAt, updated_at_ms: Date.now(), created_by_client_id: "c" });
    const upload = async (jobs: ReturnType<typeof job>[]) => {
      const payload = sync(identity, []);
      return send("sync", { ...payload, message: { ...(payload.message as object), jobs } });
    };
    expect((await upload([job("recorded", "running")])).status).toBe(200);
    let changed = false;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...args: any[]) => wrap(target.bind(...args), sql);
      if (key === "first") return async () => {
        const row = await target.first();
        if (!changed && sql.startsWith("SELECT jobs_json")) {
          changed = true;
          expect((await send("/auth/clients/c/recording", { record_jobs: false })).status).toBe(200);
          if (change === "new-window") expect((await send("/auth/clients/c/recording", { record_jobs: true })).status).toBe(200);
        }
        return row;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    prepare.mockImplementation(sql => wrap(db.prepare(sql), sql));
    expect((await upload([job("recorded", "succeeded"), job("late-new", "running")])).status).toBe(200);
    expect(changed).toBe(true);
    const result = await (await send("jobs", {}, "GET")).json() as { jobs: unknown[] };
    expect(result.jobs).toEqual([expect.objectContaining({ job_id: "recorded", status: "succeeded" })]);
  });
});

it.each([7, 1])("overlapping settings requests keep the latest retention after an initial %s-day policy", async initialDays => {
  await fixture(async (instance, _state, send, _identity, prepare) => {
    const initial = { ...DEFAULT_JOB_HISTORY, retention_days: initialDays };
    expect((await send("history-settings", initial)).status).toBe(200);
    let paused = false, release!: () => void, reached!: () => void, changed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const latestStored = new Promise<void>(resolve => { changed = resolve; });
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...args: any[]) => wrap(target.bind(...args), sql);
      if (key === "run") return async () => {
        if (!paused && sql.startsWith("UPDATE runmesh_job_snapshots_v1 SET retention_days=")) { paused = true; reached(); await gate; }
        return target.run();
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    prepare.mockImplementation(sql => wrap(db.prepare(sql), sql));
    const update = instance.setJobHistorySettings.bind(instance);
    const observe = vi.spyOn(instance, "setJobHistorySettings").mockImplementation((id, settings) => {
      const saved = update(id, settings);
      if (saved && instance.jobHistorySettings(id).retention_days === 1) changed();
      return saved;
    });
    try {
      const earlier = send("history-settings", { ...initial, retention_days: initialDays === 1 ? 7 : 3 });
      await waiting;
      const latest = send("history-settings", { ...initial, retention_days: 1 });
      await latestStored; release();
      const responses = await Promise.all([earlier, latest]);
      for (const response of responses) { expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ retention_days: 1 }); }
      expect(instance.jobHistorySettings("r").retention_days).toBe(1);
      const row = await db.prepare("SELECT retention_days FROM runmesh_job_snapshots_v1 WHERE namespace=? AND runner_id='r'").bind(_state.id.toString()).first();
      expect(row).toEqual({ retention_days: 1 });
    } finally { release(); observe.mockRestore(); }
  });
});

it.each([true, false])("reporting capability negotiation is explicit, new peer=%s", async capable => {
  await fixture(async (_instance, _state, send, identity) => {
    const response = await send("connect", { session_id: "new-reporting-session", credential_version: identity.credential_version, lifecycle_id: identity.lifecycle_id,
      now_ms: Date.now(), min_protocol_version: 2, max_protocol_version: 2,
      metadata: { runner_id: "r", runner_version: "0.1.3", platform: "test", architecture: "test",
        capabilities: { filesystem: true, process_execution: true, workspace_sync: true, pty: false, network_access: false,
          max_concurrent_jobs: 1, supported_rpc_methods: ["exec.start"],
          labels: { job_history_protocol: "1", ...(capable ? { job_reporting_protocol: "2" } : {}) } } } });
    expect(response.status).toBe(200);
    const result = await response.json() as Record<string, unknown>;
    expect(result.job_history).toEqual(DEFAULT_JOB_HISTORY);
    if (capable) expect(result.job_reporting).toBe(2);
    else expect(result).not.toHaveProperty("job_reporting");
  });
});
