import {env,runInDurableObject} from "cloudflare:test";
import {expect,it,vi} from "vitest";
import {PackedJobHistory} from "../src/job-history-store.js";

it("bounds a day's required heartbeat SQL and writes no Job/audit/nonce history",async()=>{
  const stub=env.REGISTRY.get(env.REGISTRY.idFromName(`idle-budget-${crypto.randomUUID()}`));
  await runInDurableObject(stub,(instance,state)=>{
    const now=Date.now();instance.registerRunner("r","a".repeat(64),now,undefined,"dedicated_user");
    const identity=instance.getRunnerExecutionState("r")!;
    state.storage.sql.exec("UPDATE runners SET state='online',session_id='budget-session',last_heartbeat_ms=? WHERE runner_id='r'",now);
    const original=state.storage.sql.exec.bind(state.storage.sql),cursors:Array<{rowsRead:number;rowsWritten:number}>=[];
    const spy=vi.spyOn(state.storage.sql,"exec").mockImplementation((sql:string,...args:any[])=>{const cursor=original(sql,...args);cursors.push(cursor);return cursor;});
    try {
      for(let i=1;i<=2880;i++) expect(instance.recordHeartbeat("r",identity.runner.connection_epoch,identity.runner.credential_version,now+i*30000,identity.lifecycle_id,"budget-session")).toBe(true);
      expect(spy.mock.calls.some(([sql])=>/INSERT INTO (jobs|mcp_calls|internal_request_nonces)/.test(sql))).toBe(false);
      const reads=cursors.reduce((n,c)=>n+c.rowsRead,0),writes=cursors.reduce((n,c)=>n+c.rowsWritten,0);
      expect(reads).toBeLessThanOrEqual(2880*4);expect(writes).toBeLessThanOrEqual(2880*4);
      console.log(JSON.stringify({scenario:"required_heartbeat_sql_24h",heartbeats:2880,rows_read:reads,rows_written:writes}));
    } finally {spy.mockRestore();}
  });
});

it("empty scheduled Job cleanup has zero writes after initialization and bounded reads",async()=>{
  const raw=(env as unknown as {HISTORY_DB:D1Database}).HISTORY_DB;
  let reads=0,writes=0;const unwrapped=new WeakMap<object,D1PreparedStatement>();
  const count=(result:any)=>{reads+=result.meta.rows_read;writes+=result.meta.rows_written;return result;};
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>{
    const value={bind:(...args:any[])=>wrap(statement.bind(...args)),
      first:async(column?:string)=>{const result=count(await statement.all());const row=result.results[0];return row===undefined?null:column===undefined?row:(row as any)[column];},
      all:async()=>count(await statement.all()),run:async()=>count(await statement.run())} as D1PreparedStatement;
    unwrapped.set(value,statement);return value;
  };
  const db={prepare:(query:string)=>wrap(raw.prepare(query)),batch:async(statements:D1PreparedStatement[])=>{const results=await raw.batch(statements.map(s=>unwrapped.get(s)??s));return results.map(count);}} as D1Database;
  const namespace=`empty-cron-${crypto.randomUUID()}`;
  await new PackedJobHistory(db,namespace).cleanup();reads=0;writes=0;
  for(let i=0;i<96;i++) await new PackedJobHistory(db,namespace).cleanup();
  expect(writes).toBe(0);expect(reads).toBeLessThan(2000);
  console.log(JSON.stringify({scenario:"empty_job_cleanup_24h",cron_turns:96,rows_read:reads,rows_written:writes}));
});
