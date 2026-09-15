import {expect,it,vi} from "vitest";
import {env,runInDurableObject} from "cloudflare:test";
import {runnerPolicyChecksum,encodeWireFrame,PROTOCOL_CURRENT_VERSION} from "@aloneio/runmesh-protocol";
import {signQueueGrant,verifyQueueGrant,launchDigest} from "../src/queue-grant.js";
const secret="synthetic-queue-signing-secret-at-least-32";
const payload={version:1 as const,runner_id:"r",lifecycle_id:"lifecycle-queue-tests",credential_version:1,client_id:"c",secret_version:1,workspace_id:"w",policy_revision:1,policy_checksum:"a".repeat(64),launch_digest:"b".repeat(64),expires_at_ms:Date.now()+3500000,nonce:"queue-test-nonce"};
it("queue grants authenticate the full context and reject tampering, cross-key reuse and expiry",async()=>{
 const grant=await signQueueGrant(secret,payload);expect(await verifyQueueGrant(secret,grant)).toEqual(payload);
 expect(await verifyQueueGrant(secret,{...grant,payload:{...payload,client_id:"other"}})).toBeUndefined();
 expect(await verifyQueueGrant(secret+"other",grant)).toBeUndefined();expect(await verifyQueueGrant(secret,grant,payload.expires_at_ms)).toBeUndefined();
 expect(await launchDigest({workspace_id:"w",command:"a",shell:true})).not.toBe(await launchDigest({workspace_id:"w",command:"b",shell:true}));
});
it.each([true,false])("dequeue requires a fresh client permission decision, allowed=%s",async(allowed)=>{
 const stub=env.RUNNER.get(env.RUNNER.idFromName(`queue-auth-${crypto.randomUUID()}`));
 await runInDurableObject(stub,async instance=>{
  const target=instance as any,attachment={runnerId:"r",sessionId:"session-q",epoch:1,credentialVersion:1,lifecycleId:payload.lifecycle_id,protocolVersion:PROTOCOL_CURRENT_VERSION,authenticated:true,queueProtocol:1};
  const send=vi.fn(),socket={deserializeAttachment:()=>attachment,send,close:vi.fn()} as unknown as WebSocket;
  target.isCurrent=async()=>true;target.admitOrReconcileProtectedRpc=async()=>true;target.admissionState={};target.admitsProtectedRpc=()=>true;
  target.env={...target.env,INTERNAL_CONTROL_SECRET:secret};
  const wsSpy=vi.spyOn(target.ctx,"getWebSockets").mockReturnValue([socket]);
  const auth=vi.fn(async()=>Response.json({ok:allowed},{status:allowed?200:403}));target.registryRequest=auth;
  try{
   await target.webSocketMessage(socket,encodeWireFrame({type:"runner.queue_check",protocol_version:PROTOCOL_CURRENT_VERSION,request_id:"q-check",runner_id:"r",job_id:"queued-j",grant:await signQueueGrant(secret,payload)}));
   expect(auth).toHaveBeenCalledTimes(1);expect(auth.mock.calls[0]?.[1]).toBe("/mcp-authorization");
   expect(JSON.parse(send.mock.calls[0]![0]).result.authorized).toBe(allowed);
  }finally{wsSpy.mockRestore();}
 });
});

it.each(["credential","lifecycle","expiry","policy-race"])("dequeue denies %s changes without authorizing execution",async(change)=>{
 const stub=env.RUNNER.get(env.RUNNER.idFromName(`queue-denial-${crypto.randomUUID()}`));
 await runInDurableObject(stub,async instance=>{
  const target=instance as any,attachment={runnerId:"r",sessionId:"session-q",epoch:1,credentialVersion:change==="credential"?2:1,lifecycleId:change==="lifecycle"?"replacement-lifecycle":payload.lifecycle_id,protocolVersion:PROTOCOL_CURRENT_VERSION,authenticated:true,queueProtocol:1};
  const send=vi.fn(),socket={deserializeAttachment:()=>attachment,send,close:vi.fn()} as unknown as WebSocket;
  target.isCurrent=async()=>true;target.admitOrReconcileProtectedRpc=async()=>true;target.admissionState={};
  target.admitsProtectedRpc=()=>change!=="policy-race";target.env={...target.env,INTERNAL_CONTROL_SECRET:secret};
  const sockets=vi.spyOn(target.ctx,"getWebSockets").mockReturnValue([socket]);
  const auth=vi.fn(async()=>Response.json({ok:true}));target.registryRequest=auth;
  try{
   const grant=await signQueueGrant(secret,{...payload,...(change==="expiry"?{expires_at_ms:Date.now()-1}:{})});
   await target.webSocketMessage(socket,encodeWireFrame({type:"runner.queue_check",protocol_version:PROTOCOL_CURRENT_VERSION,request_id:"q-deny",runner_id:"r",job_id:"queued-j",grant}));
   expect(JSON.parse(send.mock.calls[0]![0]).result.authorized).toBe(false);
   if(change!=="policy-race")expect(auth).not.toHaveBeenCalled();
  }finally{sockets.mockRestore();}
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
