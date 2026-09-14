import { env,runInDurableObject } from "cloudflare:test";
import { expect,it,vi } from "vitest";
import { PackedJobHistory } from "../src/job-history-store.js";
import { internalHeaders } from "../src/security.js";
import { DEFAULT_JOB_HISTORY } from "../src/job-history-settings.js";
const db=(env as unknown as {HISTORY_DB:D1Database}).HISTORY_DB;

type Send=(action:string,input:Record<string,unknown>,method?:string)=>Promise<Response>;
async function fixture(test:(instance:any,state:DurableObjectState,send:Send,identity:Record<string,unknown>)=>Promise<void>) {
  const stub=env.REGISTRY.get(env.REGISTRY.idFromName(`packed-integration-${crypto.randomUUID()}`));
  await runInDurableObject(stub,async(instance,state)=>{
    const now=Date.now();
    instance.registerRunner("r","a".repeat(64),now,undefined,"dedicated_user");
    instance.createMcpClient({client_id:"c",label:"test",secret_verifier:"b".repeat(64),secret_prefix:"test",scopes:["coding:read","coding:exec"]},now);
    const fence=instance.getRunnerExecutionState("r")!;
    state.storage.sql.exec("UPDATE runners SET state='online',session_id='history-session',last_heartbeat_ms=? WHERE runner_id='r'",now);
    const identity={epoch:fence.runner.connection_epoch,credential_version:fence.runner.credential_version,lifecycle_id:fence.lifecycle_id,session_id:"history-session",now_ms:now};
    (instance as any).env={...(instance as any).env,HISTORY_DB:db,RUNMESH_JOB_HISTORY_BACKEND:"d1"};
    (instance as any).packedJobs=new PackedJobHistory(db,state.id.toString());
    const send:Send=async(action,input,method="POST")=>{
      const path=`/runners/r/${action}`,body=method==="GET"?"":JSON.stringify(input);
      return instance.fetch(new Request(`https://registry.internal${path}`,{method,headers:await internalHeaders(env.INTERNAL_CONTROL_SECRET,method,path,body),...(method==="GET"?{}:{body})}));
    };
    await test(instance,state,send,identity);
  });
}
function sync(identity:Record<string,unknown>,ids=["one","two"]):Record<string,unknown> {
  const now=Date.now();
  return {...identity,message:{type:"runner.sync",protocol_version:2,runner_id:"r",sync_sequence:1,sent_at_ms:now,workspaces:[],jobs:ids.map(job_id=>({job_id,runner_id:"r",workspace_id:"w",status:"succeeded",created_at_ms:now,updated_at_ms:now,created_by_client_id:"c"}))}};
}

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
  await fixture(async(instance,state,send,identity)=>{
    expect((await send("sync",{...sync(identity),session_id:"stale"})).status).toBe(409);
    instance.setJobRecording("c",false,Date.now());
    expect(await (await send("sync",sync(identity))).json()).toMatchObject({history_status:"unchanged"});
    expect((await (await send("jobs?limit=10",{},"GET")).json() as any).jobs).toEqual([]);
    instance.setJobHistorySettings("r",{...DEFAULT_JOB_HISTORY,mode:"off"});
    const merge=vi.fn(()=>{throw new Error("unexpected archive access");});
    (instance as any).packedJobs={merge};
    expect(await (await send("sync",sync(identity))).json()).toMatchObject({history_status:"disabled"});
    expect(merge).not.toHaveBeenCalled();
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs").one().n).toBe(0);
  });
});

it("archive failure reports degraded history without changing Runner availability",async()=>{
  await fixture(async(instance,state,send,identity)=>{
    (instance as any).packedJobs=new PackedJobHistory({prepare:()=>{throw new Error("synthetic daily read quota exceeded");}} as any,state.id.toString());
    const response=await send("sync",sync(identity));
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({history_status:"degraded"});
    expect(instance.getRunner("r")?.state).toBe("online");
    expect((await send("jobs?limit=10",{},"GET")).status).toBe(503);
  });
});
