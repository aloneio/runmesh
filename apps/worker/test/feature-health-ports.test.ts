import { BridgeReplies } from "../src/platform/bridge-replies.js";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { RegistryFeatureHealthStore } from "../src/registry/feature-health.js";

it("feature health construction is I/O-free and persistence remains synchronous", async () => {
  const stub=env.REGISTRY.get(env.REGISTRY.idFromName(`feature-ports-${crypto.randomUUID()}`));
  await runInDurableObject(stub,async (_instance,state)=>{
    const statements:string[]=[];
    const sql=new Proxy(state.storage.sql,{get(target,key){
      const value=Reflect.get(target,key,target);
      if(key==="exec")return (query:string,...args:unknown[])=>{statements.push(query);return Reflect.apply(value,target,[query,...args]);};
      return typeof value==="function"?value.bind(target):value;
    }});
    const health=new RegistryFeatureHealthStore(sql);
    expect(statements).toEqual([]);
    expect(health.disable("mcp_audit",new Error("quota"),1000,5000)).toBe(6000);
    expect(statements).toHaveLength(1);
    expect(health.snapshot(1001)).toMatchObject([{feature:"mcp_audit",failure_count:1,last_error:"Error: quota",disabled_until_ms:6000}]);
    const restored=new RegistryFeatureHealthStore(sql);restored.load(1001);
    expect(restored.snapshot(1001)).toEqual(health.snapshot(1001));
    const count=statements.length;expect(restored.disabled("mcp_audit",6000)).toBe(false);
    expect(restored.snapshot(6000)).toEqual([]);expect(statements).toHaveLength(count);
    health.clear("mcp_audit");expect(statements).toHaveLength(count+1);
  });
});
it("optional storage failure retains its in-memory breaker without scheduling an alarm",async()=>{
  const stub=env.REGISTRY.get(env.REGISTRY.idFromName(`feature-failure-${crypto.randomUUID()}`));
  await runInDurableObject(stub,async (_instance,state)=>{
    const alarm=await state.storage.getAlarm();let calls=0;
    const sql=new Proxy(state.storage.sql,{get(target,key){
      if(key==="exec")return ()=>{calls++;throw new Error("synthetic storage unavailable");};
      const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
    }});
    const health=new RegistryFeatureHealthStore(sql);expect(calls).toBe(0);
    health.load(1000);health.disable("maintenance_alarm","unavailable",1000,5000);health.disable("maintenance_alarm","unavailable",1001,5000);
    expect(health.disabled("maintenance_alarm",1002)).toBe(true);
    expect(health.snapshot(1002)).toMatchObject([{failure_count:2,disabled_until_ms:6001}]);
    expect(calls).toBe(3);expect(await state.storage.getAlarm()).toBe(alarm);
  });
});

it("reply ownership rejects wrong sockets and settles each matching waiter at most once",()=>{
  const a=new WebSocketPair(),b=new WebSocketPair();
  a[0].accept();a[1].accept();b[0].accept();b[1].accept();
  const replies=new BridgeReplies(),first=vi.fn(),second=vi.fn();
  const timers=[setTimeout(()=>{},10000),setTimeout(()=>{},10000)];
  try{
    expect(replies.size).toBe(0);
    replies.register("one",{socket:a[0],timer:timers[0]!,resolve:first});
    replies.register("two",{socket:b[0],timer:timers[1]!,resolve:second});
    replies.deliver(b[0],{type:"rpc.response",protocol_version:2,request_id:"one",result:{ok:true}});
    expect(first).not.toHaveBeenCalled();expect(replies.size).toBe(2);
    replies.deliver(a[0],{type:"rpc.response",protocol_version:2,request_id:"one",result:{ok:true}});
    replies.deliver(a[0],{type:"rpc.response",protocol_version:2,request_id:"one",result:{ok:true}});
    expect(first).toHaveBeenCalledTimes(1);expect(replies.size).toBe(1);
    replies.reject(a[0],()=>{throw new Error("wrong socket must not project a reply");});
    expect(second).not.toHaveBeenCalled();
    replies.reject(b[0],request_id=>({type:"rpc.error",protocol_version:2,request_id,error:{code:"runner_offline",message:"unavailable"}}));
    expect(second).toHaveBeenCalledTimes(1);expect(replies.size).toBe(0);
  }finally{for(const timer of timers)clearTimeout(timer);a[0].close();a[1].close();b[0].close();b[1].close();}
});
