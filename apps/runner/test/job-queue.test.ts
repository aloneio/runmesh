import { mkdtemp,mkdir,realpath,rm,readFile,writeFile,cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it,vi } from "vitest";
import { nativeJobFiles } from "../src/jobs/storage.js";
import type { JobFilePort } from "../src/jobs/ports.js";
import { JobManager } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { FairJobQueue } from "../src/job-queue.js";
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(done:()=>boolean){for(let i=0;i<400;i++){if(done())return;await sleep(20);}throw new Error("queue did not converge");}
async function fixture(authorize=vi.fn(async()=>true), files: JobFilePort = nativeJobFiles){
 const base=await mkdtemp(join(tmpdir(),"runmesh-fair-queue-"));const root=join(base,"work");await mkdir(root);
 const policy=new PathPolicy([{workspaceId:"w",rootPath:await realpath(root),readonly:false,shell:false}]);
 const started:string[]=[];
 const jobs=new JobManager({policy,stateDir:join(base,"state"),maxConcurrentJobs:1,maxQueuedJobs:4,maxQueuedJobsPerClient:2,authorizeQueuedJob:authorize,onEvent:e=>{if(e.type==="started")started.push(e.job.request_id??"");}}, {files});
 await jobs.initialize();
 const launch=(client:string,id:string,delay=80,extra:Record<string,unknown>={})=>jobs.start({workspace_id:"w",command:[process.execPath,"-e",`setTimeout(()=>process.stdout.write(${JSON.stringify(id)}),${delay})`],created_by_client_id:client,request_id:id,...extra});
 const hold=(client:string,id:string)=>jobs.start({workspace_id:"w",command:[process.execPath,"-e",`const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root,id+".release"))})){clearInterval(t);process.stdout.write(${JSON.stringify(id)});}},15);`],created_by_client_id:client,request_id:id});
 const release=(id:string)=>writeFile(join(root,id+".release"),"release");
 const close=async()=>{for(const job of jobs.list())await jobs.cancel(job.job_id);await wait(()=>jobs.queueStatus().running===0);await rm(base,{recursive:true,force:true,maxRetries:10,retryDelay:50});};
 return {jobs,launch,hold,release,started,authorize,policy,root,base,close};
}
it("queues two MCP clients fairly while preserving FIFO within each client",async()=>{
 const f=await fixture();try{
  const hold=await f.hold("a","hold");
  const a1=await f.launch("a","a1"),a2=await f.launch("a","a2"),b1=await f.launch("b","b1");
  expect([a1.status,a2.status,b1.status]).toEqual(["queued","queued","queued"]);
  expect(f.jobs.queueStatus()).toMatchObject({running:1,waiting:3});
  expect((await f.jobs.start({workspace_id:"w",command:[process.execPath,"-e","setTimeout(()=>process.stdout.write(\"a1\"),80)"],created_by_client_id:"a",request_id:"a1"})).job_id).toBe(a1.job_id);
  await f.release("hold");
  await wait(()=>[hold,a1,a2,b1].every(j=>f.jobs.get(j.job_id).status==="succeeded"));
  expect(f.authorize).toHaveBeenCalledTimes(3);
  expect(f.authorize.mock.calls.map((call: any[]) => call[1].request_id)).toEqual(["b1","a1","a2"]);
  expect(f.jobs.queueStatus()).toMatchObject({running:0,waiting:0});
 }finally{await f.close();}
});
it("cancelling a queued task never spawns it or consumes an execution slot",async()=>{
 const f=await fixture();try{
  const hold=await f.hold("a","hold"),next=await f.launch("b","cancel-me");
  expect((await f.jobs.cancel(next.job_id)).status).toBe("cancelled");
  await f.release("hold");
  await wait(()=>f.jobs.get(hold.job_id).status==="succeeded");
  expect(f.started).toEqual(["hold"]);expect(f.authorize).not.toHaveBeenCalled();
  expect(f.jobs.get(next.job_id).pid).toBeNull();
 }finally{await f.close();}
});
it("per-client limits do not prevent another client from entering the queue",async()=>{
 const f=await fixture();try{
  await f.hold("a","hold");await f.launch("a","a1");await f.launch("a","a2");
  await expect(f.launch("a","overflow")).rejects.toMatchObject({code:"queue_full"});
  expect((await f.launch("b","b1")).status).toBe("queued");
  await expect(f.launch("b","immediate",80,{queue:false})).rejects.toMatchObject({code:"busy"});
 }finally{await f.close();}
});
it("a queued task is refused if fresh authorization or the local policy changed",async()=>{
 const authorization=vi.fn(async()=>false),f=await fixture(authorization);try{
  await f.hold("a","hold");const denied=await f.launch("b","denied");
  await f.release("hold");
  await wait(()=>f.jobs.get(denied.job_id).status==="failed");expect(f.jobs.get(denied.job_id).pid).toBeNull();
  await f.hold("a","hold2");const stale=await f.launch("b","stale");f.policy.replace([]);await f.release("hold2");
  await wait(()=>f.jobs.get(stale.job_id).status==="failed");expect(f.jobs.get(stale.job_id).pid).toBeNull();
 }finally{await f.close();}
});
it("waiting state is persisted and a fresh Runner never blindly replays an old queue",async()=>{
 const f=await fixture();try{
  await f.hold("a","hold");const queued=await f.launch("b","waiting");
  expect(JSON.parse(await readFile(join(f.base,"state","jobs",queued.job_id,"meta.json"),"utf8")).status).toBe("queued");
  const recoveredRoot=join(f.base,"recovered");await mkdir(join(recoveredRoot,"jobs"),{recursive:true});
  await cp(join(f.base,"state","jobs",queued.job_id),join(recoveredRoot,"jobs",queued.job_id),{recursive:true});
  const recovered=new JobManager({policy:f.policy,stateDir:recoveredRoot});await recovered.initialize();
  expect(recovered.get(queued.job_id).status).toBe("interrupted");expect(recovered.get(queued.job_id).pid).toBeNull();
  expect(recovered.queueStatus().waiting).toBe(0);
  await f.jobs.cancel(queued.job_id);
 }finally{await f.close();}
});
it("round robin cannot starve existing clients as new clients arrive",()=>{
 const queue=new FairJobQueue<number>(10,4);queue.push("a","a1",1);queue.push("a","a2",2);queue.push("b","b1",3);queue.served("a");
 expect(queue.shift()?.id).toBe("b1");queue.push("c","c1",4);expect(queue.shift()?.id).toBe("a1");
});

it("cancellation during initial queue persistence cannot resurrect a queued record",async()=>{
 let release!:()=>void, observed!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;}), entered=new Promise<void>(resolve=>{observed=resolve;});
 const files:JobFilePort={...nativeJobFiles,async atomicJson(path,value){
  if(typeof value==="object" && value!==null && "request_id" in value && value.request_id==="cancel-during" && "status" in value && value.status==="queued") {observed();await blocked;}
  await nativeJobFiles.atomicJson(path,value);
 }};
 const f=await fixture(vi.fn(async()=>true),files);try{
  await f.hold("a","hold");
  const launching=f.launch("b","cancel-during"); await entered;
  const queued=f.jobs.list().find(job=>job.request_id==="cancel-during");expect(queued).toBeDefined();
  const cancelling=f.jobs.cancel(queued!.job_id);release();
  expect((await launching).status).toBe("cancelled");await cancelling;await f.jobs.flushPersistence();
  expect(f.jobs.queueStatus().waiting).toBe(0);
  expect(JSON.parse(await readFile(join(f.base,"state","jobs",queued!.job_id,"meta.json"),"utf8")).status).toBe("cancelled");
 }finally{release();await f.close();}
});

it("cancellation while a dequeue authorization is pending never spawns the task",async()=>{
 let release!:(value:boolean)=>void,checking=false;
 const authorize=vi.fn(()=>new Promise<boolean>(resolve=>{checking=true;release=resolve;}));
 const f=await fixture(authorize);try{
  await f.hold("a","hold");const queued=await f.launch("b","pending-auth");
  await f.release("hold");
  await wait(()=>checking);await f.jobs.cancel(queued.job_id);release(true);
  await sleep(60);expect(f.jobs.get(queued.job_id).status).toBe("cancelled");expect(f.jobs.get(queued.job_id).pid).toBeNull();expect(f.started).toEqual(["hold"]);
 }finally{release?.(false);await f.close();}
});

it.each([true, false])("dequeue may suppress reporting but never enable an originally private job: %s", async initiallyRecorded => {
 const authorize=vi.fn(async(...args:unknown[])=>{(args[0] as Record<string,unknown>).record_history=!initiallyRecorded;return true;});
 const f=await fixture(authorize);try{
  const hold=await f.hold("a","hold");
  const next=await f.launch("b","private-dequeued",80,{record_history:initiallyRecorded});
  expect(next.status).toBe("queued");await f.release("hold");
  await wait(()=>[hold,next].every(j=>f.jobs.get(j.job_id).status==="succeeded"));
  expect(f.jobs.get(next.job_id)).toHaveProperty("record_history",false);
  expect((await f.jobs.snapshotForSync()).some(j=>j.job_id===next.job_id)).toBe(false);
  expect(await f.jobs.logs(next.job_id)).toMatchObject({data:"private-dequeued"});
 }finally{await f.close();}
});
