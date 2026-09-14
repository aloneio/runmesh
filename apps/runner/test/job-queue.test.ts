import { mkdtemp,mkdir,realpath,rm,readFile,cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it,vi } from "vitest";
import { JobManager } from "../src/jobs.js";
import { PathPolicy } from "../src/path-policy.js";
import { FairJobQueue } from "../src/job-queue.js";
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(done:()=>boolean){for(let i=0;i<400;i++){if(done())return;await sleep(20);}throw new Error("queue did not converge");}
async function fixture(authorize=vi.fn(async()=>true)){
 const base=await mkdtemp(join(tmpdir(),"runmesh-fair-queue-"));const root=join(base,"work");await mkdir(root);
 const policy=new PathPolicy([{workspaceId:"w",rootPath:await realpath(root),readonly:false,shell:false}]);
 const started:string[]=[];
 const jobs=new JobManager({policy,stateDir:join(base,"state"),maxConcurrentJobs:1,maxQueuedJobs:4,maxQueuedJobsPerClient:2,authorizeQueuedJob:authorize,onEvent:e=>{if(e.type==="started")started.push(e.job.request_id??"");}});
 await jobs.initialize();
 const launch=(client:string,id:string,delay=80,extra:Record<string,unknown>={})=>jobs.start({workspace_id:"w",command:[process.execPath,"-e",`setTimeout(()=>process.stdout.write(${JSON.stringify(id)}),${delay})`],created_by_client_id:client,request_id:id,...extra});
 const close=async()=>{for(const job of jobs.list())await jobs.cancel(job.job_id);await wait(()=>jobs.queueStatus().running===0);await rm(base,{recursive:true,force:true,maxRetries:10,retryDelay:50});};
 return {jobs,launch,started,authorize,policy,root,base,close};
}
it("queues two MCP clients fairly while preserving FIFO within each client",async()=>{
 const f=await fixture();try{
  const hold=await f.launch("a","hold",500);
  const a1=await f.launch("a","a1"),a2=await f.launch("a","a2"),b1=await f.launch("b","b1");
  expect([a1.status,a2.status,b1.status]).toEqual(["queued","queued","queued"]);
  expect(f.jobs.queueStatus()).toMatchObject({running:1,waiting:3});
  expect((await f.jobs.start({workspace_id:"w",command:[process.execPath,"-e","setTimeout(()=>process.stdout.write(\"a1\"),80)"],created_by_client_id:"a",request_id:"a1"})).job_id).toBe(a1.job_id);
  await wait(()=>[hold,a1,a2,b1].every(j=>f.jobs.get(j.job_id).status==="succeeded"));
  expect(f.started).toEqual(["hold","b1","a1","a2"]);expect(f.authorize).toHaveBeenCalledTimes(3);
  expect(f.jobs.queueStatus()).toMatchObject({running:0,waiting:0});
 }finally{await f.close();}
});
it("cancelling a queued task never spawns it or consumes an execution slot",async()=>{
 const f=await fixture();try{
  const hold=await f.launch("a","hold",300),next=await f.launch("b","cancel-me");
  expect((await f.jobs.cancel(next.job_id)).status).toBe("cancelled");
  await wait(()=>f.jobs.get(hold.job_id).status==="succeeded");
  expect(f.started).toEqual(["hold"]);expect(f.authorize).not.toHaveBeenCalled();
  expect(f.jobs.get(next.job_id).pid).toBeNull();
 }finally{await f.close();}
});
it("per-client limits do not prevent another client from entering the queue",async()=>{
 const f=await fixture();try{
  await f.launch("a","hold",600);await f.launch("a","a1");await f.launch("a","a2");
  await expect(f.launch("a","overflow")).rejects.toMatchObject({code:"queue_full"});
  expect((await f.launch("b","b1")).status).toBe("queued");
  await expect(f.launch("b","immediate",80,{queue:false})).rejects.toMatchObject({code:"busy"});
 }finally{await f.close();}
});
it("a queued task is refused if fresh authorization or the local policy changed",async()=>{
 const authorization=vi.fn(async()=>false),f=await fixture(authorization);try{
  await f.launch("a","hold",200);const denied=await f.launch("b","denied");
  await wait(()=>f.jobs.get(denied.job_id).status==="failed");expect(f.jobs.get(denied.job_id).pid).toBeNull();
  await f.launch("a","hold2",200);const stale=await f.launch("b","stale");f.policy.replace([]);
  await wait(()=>f.jobs.get(stale.job_id).status==="failed");expect(f.jobs.get(stale.job_id).pid).toBeNull();
 }finally{await f.close();}
});
it("waiting state is persisted and a fresh Runner never blindly replays an old queue",async()=>{
 const f=await fixture();try{
  await f.launch("a","hold",300);const queued=await f.launch("b","waiting");
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
 const f=await fixture();try{
  await f.launch("a","hold",300);
  const target=f.jobs as any,original=target.persist.bind(target);
  const spy=vi.spyOn(target,"persist").mockImplementation(async(job:any)=>{
   if(job.request_id==="cancel-during" && job.status==="queued")await f.jobs.cancel(job.job_id);
   return original(job);
  });
  try{const job=await f.launch("b","cancel-during");expect(job.status).toBe("cancelled");expect(f.jobs.queueStatus().waiting).toBe(0);}finally{spy.mockRestore();}
 }finally{await f.close();}
});

it("cancellation while a dequeue authorization is pending never spawns the task",async()=>{
 let release!:(value:boolean)=>void,checking=false;
 const authorize=vi.fn(()=>new Promise<boolean>(resolve=>{checking=true;release=resolve;}));
 const f=await fixture(authorize);try{
  await f.launch("a","hold",150);const queued=await f.launch("b","pending-auth");
  await wait(()=>checking);await f.jobs.cancel(queued.job_id);release(true);
  await sleep(60);expect(f.jobs.get(queued.job_id).status).toBe("cancelled");expect(f.jobs.get(queued.job_id).pid).toBeNull();expect(f.started).toEqual(["hold"]);
 }finally{release?.(false);await f.close();}
});
