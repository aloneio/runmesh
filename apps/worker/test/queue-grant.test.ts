import {expect,it,vi} from "vitest";
import {env,runInDurableObject} from "cloudflare:test";
import {encodeWireFrame,PROTOCOL_CURRENT_VERSION} from "@aloneio/runmesh-protocol";
import {signQueueGrant,verifyQueueGrant,launchDigest} from "../src/queue-grant.js";
import {runnerSession} from "./helpers/runner-session.js";
const secret="synthetic-queue-signing-secret-at-least-32";
const payload={version:1 as const,runner_id:"r",lifecycle_id:"lifecycle-queue-tests",credential_version:1,client_id:"c",secret_version:1,workspace_id:"w",policy_revision:1,policy_checksum:"a".repeat(64),launch_digest:"b".repeat(64),expires_at_ms:Date.now()+3500000,nonce:"queue-test-nonce"};
it("queue grants authenticate the full context and reject tampering, cross-key reuse and expiry",async()=>{
 const grant=await signQueueGrant(secret,payload);expect(await verifyQueueGrant(secret,grant)).toEqual(payload);
 expect(await verifyQueueGrant(secret,{...grant,payload:{...payload,client_id:"other"}})).toBeUndefined();
 expect(await verifyQueueGrant(secret+"other",grant)).toBeUndefined();expect(await verifyQueueGrant(secret,grant,payload.expires_at_ms)).toBeUndefined();
 expect(await launchDigest({workspace_id:"w",command:"a",shell:true})).not.toBe(await launchDigest({workspace_id:"w",command:"b",shell:true}));
});
it.each([[true,200],[false,403],[true,201],[true,202],[true,203],[true,206],[true,207],[true,403],[true,409]] as const)("dequeue requires a completed permission decision, allowed=%s status=%s",async(allowed,status)=>{
 const stub=env.RUNNER.get(env.RUNNER.idFromName(`queue-auth-${crypto.randomUUID()}`));
 await runInDurableObject(stub,async (_existing,state)=>{
  const f=await runnerSession(state,env,{lifecycleId:payload.lifecycle_id});
  const base=f.registry.request;
  const auth=vi.fn(async(_runner: string, _path: string, _init: RequestInit)=>Response.json({ok:allowed},{status}));
  const requests=vi.fn(async(runner: string,path: string,init: RequestInit)=>path==="/mcp-authorization" ? auth(runner,path,init) : base(runner,path,init));
  f.registry.request=requests;
  const grant=await signQueueGrant(env.INTERNAL_CONTROL_SECRET!,{...payload,policy_checksum:f.policy.checksum});
  await f.runner.webSocketMessage(f.socket,encodeWireFrame({type:"runner.queue_check",protocol_version:PROTOCOL_CURRENT_VERSION,request_id:"q-check",runner_id:"r",job_id:"queued-j",grant}));
  expect(requests.mock.calls.map(call=>call[1])).toEqual(["/session","/policy-readiness","/active-policy","/mcp-authorization"]);
  expect(auth).toHaveBeenCalledTimes(1);expect(auth.mock.calls[0]?.[1]).toBe("/mcp-authorization");
  expect(f.frames).toHaveLength(1);
  expect(f.frames[0]).toMatchObject({type:"rpc.response",request_id:"q-check",result:{authorized:allowed && status===200}});
  expect(f.socket.close).not.toHaveBeenCalled();
 });
});

it.each(["credential","lifecycle","expiry","policy-race"])("dequeue denies %s changes without authorizing execution",async(change)=>{
 const stub=env.RUNNER.get(env.RUNNER.idFromName(`queue-denial-${crypto.randomUUID()}`));
 await runInDurableObject(stub,async (_existing,state)=>{
  const f=await runnerSession(state,env,{history:true,credentialVersion:change==="credential"?2:1,
   lifecycleId:change==="lifecycle"?"replacement-lifecycle":payload.lifecycle_id});
  const base=f.registry.request;
  const auth=vi.fn(async()=>{
   if(change==="policy-race")expect((await f.request("/begin-policy-mutation",{mutation_id:"queue-policy-race",runner_id:"r"})).status).toBe(204);
   return Response.json({ok:true,record_history:true});
  });
  const requests=vi.fn(async(runner: string,path: string,init: RequestInit)=>path==="/mcp-authorization" ? auth() : base(runner,path,init));
  f.registry.request=requests;
  const grant=await signQueueGrant(env.INTERNAL_CONTROL_SECRET!,{...payload,policy_checksum:f.policy.checksum,...(change==="expiry"?{expires_at_ms:Date.now()-1}:{})});
  await f.runner.webSocketMessage(f.socket,encodeWireFrame({type:"runner.queue_check",protocol_version:PROTOCOL_CURRENT_VERSION,request_id:"q-deny",runner_id:"r",job_id:"queued-j",grant}));
  expect(f.frames).toHaveLength(1);
  expect(f.frames[0]).toMatchObject({type:"rpc.response",request_id:"q-deny",result:{authorized:false,record_history:false}});
  expect(requests.mock.calls[0]?.[1]).toBe("/session");
  expect(auth).toHaveBeenCalledTimes(change==="policy-race"?1:0);
  expect(f.socket.close).not.toHaveBeenCalled();
 });
});

it("argument arrays are included in the signed launch digest",async()=>{
 expect(await launchDigest({workspace_id:"w",command:"node",args:["allowed"]})).not.toBe(await launchDigest({workspace_id:"w",command:"node",args:["different"]}));
});

it("trusted job recording is bound to the queue launch digest without changing legacy digests", async () => {
  const input = { workspace_id: "w", command: "node", shell: true };
  expect(await launchDigest({ ...input, record_history: false })).not.toBe(await launchDigest({ ...input, record_history: true }));
  expect(await launchDigest(input)).not.toBe(await launchDigest({ ...input, record_history: false }));
});
