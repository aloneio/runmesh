import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,rm,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import WebSocket from "ws";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
/** Isolated local-test browser only. Never opens a user's browser profile. */
export async function checkUiWithChromium(origin,cookie,output){
 assert.equal(new URL(origin).hostname,"127.0.0.1");
 const profile=await mkdtemp(join(tmpdir(),"runmesh-ui-browser-"));
 const child=spawn("/usr/bin/chromium",["--headless","--no-sandbox","--disable-dev-shm-usage","--no-first-run","--disable-background-networking","--remote-debugging-address=127.0.0.1","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:["ignore","ignore","pipe"]});
 let socket;const pending=new Map();let serial=0;
 try{
  const endpoint=await new Promise((resolve,reject)=>{let tail="";const timeout=setTimeout(()=>reject(new Error("Browser startup timed out")),12000);child.once("error",reject);child.stderr.on("data",chunk=>{tail+=chunk;const match=/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(tail);if(match){clearTimeout(timeout);resolve(match[1]);}});});
  socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
  const exceptions=[],requests=[];
  socket.on("message",raw=>{const message=JSON.parse(raw);if(message.id){const waiter=pending.get(message.id);if(waiter){pending.delete(message.id);clearTimeout(waiter.timer);message.error?waiter.reject(new Error(JSON.stringify(message.error))):waiter.resolve(message.result);}}else if(message.method==="Runtime.exceptionThrown")exceptions.push(message.params.exceptionDetails.text);else if(message.method==="Network.requestWillBeSent")requests.push(message.params.request.url);});
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Browser operation timed out: ${method}`));},12000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  const {targetId}=await call("Target.createTarget",{url:"about:blank"});const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
  const tab=(m,p)=>call(m,p,sessionId);
  const evaluate=async(expression)=>{const value=await tab("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(JSON.stringify(value.exceptionDetails));return value.result.value;};
  await tab("Page.enable");await tab("Runtime.enable");await tab("Network.enable");
  await tab("Network.setCookies",{cookies:cookie.split(";").map(part=>{const at=part.indexOf("=");return {name:part.slice(0,at).trim(),value:part.slice(at+1),url:origin,path:"/",secure:true,httpOnly:false,sameSite:"Lax"};})});
  await tab("Emulation.setDeviceMetricsOverride",{width:1365,height:1000,deviceScaleFactor:1,mobile:false});
  const reports=[];
  for(const locale of ["en","zh-CN"]){
   await tab("Page.navigate",{url:`${origin}/admin?lang=${locale}`});
   for(let i=0;i<100;i++){if(await evaluate("document.readyState==='complete' && window.__runmeshDynamicNavigation===true"))break;await sleep(50);}
   const first=await evaluate(`(()=>{const panel=[...document.querySelectorAll('.panel')].find(p=>/^(Recent jobs|最近任务)$/.test(p.querySelector('h2')?.textContent||''));if(!panel)throw Error('Missing recent jobs panel');window.__uiPanel=panel;window.__uiMutations=0;new MutationObserver(m=>window.__uiMutations+=m.length).observe(panel,{childList:true,subtree:true,characterData:true,attributes:true});const r=panel.getBoundingClientRect();return {lang:document.documentElement.lang,text:panel.textContent,top:r.top,height:r.height,opacity:getComputedStyle(panel).opacity}})()`);
   const requestsBefore=requests.length;await sleep(1000);
   const second=await evaluate(`(()=>{const p=window.__uiPanel,r=p.getBoundingClientRect();return {lang:document.documentElement.lang,text:p.textContent,top:r.top,height:r.height,opacity:getComputedStyle(p).opacity,mutations:window.__uiMutations,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
   assert.equal(first.lang,locale);assert.equal(first.text,second.text);assert.equal(first.top,second.top);assert.equal(first.height,second.height);assert.equal(second.opacity,"1");assert.equal(second.mutations,0);assert.equal(second.overflow,false);
   assert.equal(requests.slice(requestsBefore).filter(url=>new URL(url).pathname.startsWith("/admin")).length,0);
   if(output){await mkdir(output,{recursive:true});const image=await tab("Page.captureScreenshot",{format:"png"});await writeFile(join(output,`dashboard-${locale}.png`),Buffer.from(image.data,"base64"));}
   reports.push({locale,idle_dom_mutations:second.mutations,idle_admin_requests:0,stable_panel_geometry:true});
   // Exercise mounted SPA navigation and an explicit refresh in the selected locale.
   await evaluate("document.querySelector('.control-nav a[href=\"/admin/clients\"]').click()");
   for(let i=0;i<100;i++){if(await evaluate("location.pathname==='/admin/clients'&&!window.__runmeshLoading"))break;await sleep(50);}
   console.log(JSON.stringify({browser_navigation:await evaluate("({path:location.pathname,title:document.title,heading:document.querySelector('h1')?.textContent,nav:!!document.querySelector('.control-nav'),locale:document.documentElement.lang})")}));
   assert.equal(await evaluate("location.pathname"),"/admin/clients");
   assert.equal(await evaluate("document.documentElement.lang"),locale);
   await evaluate("document.querySelector('.control-nav a[href=\"/admin\"]').click()");
   for(let i=0;i<100;i++){if(await evaluate("location.pathname==='/admin'&&!window.__runmeshLoading"))break;await sleep(50);}
   const label=await evaluate("[...document.querySelectorAll('h2')].map(h=>h.textContent).join('|')");assert.ok(label.includes(locale==="en"?"Recent jobs":"最近任务"));
  }
  await tab("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),true);
  assert.deepEqual(exceptions,[]);
  await call("Browser.close").catch(()=>{});
  console.log(JSON.stringify({browser_ui_check:reports,mobile_horizontal_overflow:false,script_exceptions:exceptions.length}));
  return reports;
 }finally{
  for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error("Browser closed"));}pending.clear();socket?.close();
  if(child.exitCode===null){child.kill("SIGTERM");await Promise.race([new Promise(r=>child.once("exit",r)),sleep(3000)]);if(child.exitCode===null)child.kill("SIGKILL");}
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
}
