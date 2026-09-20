import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,rm,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import WebSocket from "ws";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const navigationContextErrors = new Set([
 "Execution context was destroyed.", "Execution context was destroyed", "Cannot find context with specified id",
 "Cannot find default execution context", "Inspected target navigated or closed",
]);
/** A ready previous document is not evidence that the requested navigation finished. */
export async function waitForUiNavigation(tab, expected, { now = Date.now, pause = sleep } = {}) {
 const deadline = now() + 5000, url = new URL(expected.url).href;
 const read = (method, params) => tab(method, params, Math.max(1, deadline - now()));
 const matchesFrame = frame => frame?.url === url
  && (expected.frameId === undefined || frame.id === expected.frameId)
  && (expected.loaderId === undefined || frame.loaderId === expected.loaderId);
 while (now() < deadline) {
  try {
   const { frameTree } = await read("Page.getFrameTree");
   if (matchesFrame(frameTree.frame)) {
    const value = await read("Runtime.evaluate", {
     expression: "({url:location.href,locale:document.documentElement?.lang,ready:document.readyState==='complete'&&window.__runmeshDynamicNavigation===true&&!window.__runmeshLoading})",
     returnByValue: true,
    });
    if (value.exceptionDetails) throw new Error("Browser navigation readiness evaluation failed");
    const state = value.result?.value;
    if (state?.url === url && state.locale === expected.locale && state.ready === true) {
     const current = (await read("Page.getFrameTree")).frameTree.frame;
     if (matchesFrame(current) && current.loaderId === frameTree.frame.loaderId && now() < deadline) return;
    }
   }
  } catch (error) {
   if (error?.code !== -32000 || !navigationContextErrors.has(error.message)) throw error;
  }
  await pause(Math.min(50, Math.max(0, deadline - now())));
 }
 throw new Error("Browser navigation readiness timed out after 5000 ms");
}
/** Isolated local-test browser only. Never opens a user's browser profile. */
export async function checkUiWithChromium(origin,cookie,output){
 assert.equal(new URL(origin).hostname,"127.0.0.1");
 const profile=await mkdtemp(join(tmpdir(),"runmesh-ui-browser-"));
 const child=spawn(process.env.RUNMESH_CHROMIUM_EXECUTABLE ?? "/usr/bin/chromium",["--headless","--no-sandbox","--disable-dev-shm-usage","--no-first-run","--disable-background-networking","--remote-debugging-address=127.0.0.1","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:["ignore","ignore","pipe"]});
 let socket;const pending=new Map();let serial=0;
 try{
  const endpoint=await new Promise((resolve,reject)=>{let tail="";const timeout=setTimeout(()=>reject(new Error("Browser startup timed out")),12000);child.once("error",reject);child.stderr.on("data",chunk=>{tail=(tail+chunk).slice(-16384);const match=/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(tail);if(match){clearTimeout(timeout);resolve(match[1]);}});});
  socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);});
  const exceptions=[],requests=[];
  socket.on("message",raw=>{const message=JSON.parse(raw);if(message.id){const waiter=pending.get(message.id);if(waiter){pending.delete(message.id);clearTimeout(waiter.timer);message.error?waiter.reject(Object.assign(new Error(message.error.message),{code:message.error.code})):waiter.resolve(message.result);}}else if(message.method==="Runtime.exceptionThrown")exceptions.push(message.params.exceptionDetails.text);else if(message.method==="Network.requestWillBeSent")requests.push(message.params.request.url);});
  const call=(method,params={},sessionId,timeoutMs=12000)=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Browser operation timed out: ${method}`));},timeoutMs);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  const {targetId}=await call("Target.createTarget",{url:"about:blank"});const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
  const tab=(m,p,timeoutMs)=>call(m,p,sessionId,timeoutMs);
  const evaluate=async(expression)=>{const value=await tab("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(JSON.stringify(value.exceptionDetails));return value.result.value;};
  await tab("Page.enable");await tab("Runtime.enable");await tab("Network.enable");
  await tab("Network.setCookies",{cookies:cookie.split(";").map(part=>{const at=part.indexOf("=");return {name:part.slice(0,at).trim(),value:part.slice(at+1),url:origin,path:"/",secure:true,httpOnly:false,sameSite:"Lax"};})});
  await tab("Emulation.setDeviceMetricsOverride",{width:1365,height:1000,deviceScaleFactor:1,mobile:false});
  const reports=[];
  for(const locale of ["en","zh-CN"]){
   const url=`${origin}/admin?lang=${locale}`, navigation=await tab("Page.navigate",{url});
   assert.equal(navigation.errorText,undefined);assert.ok(navigation.loaderId);
   await waitForUiNavigation(tab,{url,locale,frameId:navigation.frameId,loaderId:navigation.loaderId});
   const first=await evaluate(`(()=>{const panel=[...document.querySelectorAll('.panel')].find(p=>/^(Recent jobs|最近任务)$/.test(p.querySelector('h2')?.textContent||''));if(!panel)throw Error('Missing recent jobs panel');window.__uiPanel=panel;window.__uiMutations=0;new MutationObserver(m=>window.__uiMutations+=m.length).observe(panel,{childList:true,subtree:true,characterData:true,attributes:true});const r=panel.getBoundingClientRect();return {lang:document.documentElement.lang,text:panel.textContent,top:r.top,height:r.height,opacity:getComputedStyle(panel).opacity}})()`);
   const requestsBefore=requests.length;await sleep(1000);
   const second=await evaluate(`(()=>{const p=window.__uiPanel,r=p.getBoundingClientRect();return {lang:document.documentElement.lang,text:p.textContent,top:r.top,height:r.height,opacity:getComputedStyle(p).opacity,mutations:window.__uiMutations,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
   assert.equal(first.lang,locale);assert.equal(first.text,second.text);assert.equal(first.top,second.top);assert.equal(first.height,second.height);assert.equal(second.opacity,"1");assert.equal(second.mutations,0);assert.equal(second.overflow,false);
   assert.equal(requests.slice(requestsBefore).filter(url=>new URL(url).pathname.startsWith("/admin")).length,0);
   if(output){await mkdir(output,{recursive:true});const image=await tab("Page.captureScreenshot",{format:"png"});await writeFile(join(output,`dashboard-${locale}.png`),Buffer.from(image.data,"base64"));}
   reports.push({locale,idle_dom_mutations:second.mutations,idle_admin_requests:0,stable_panel_geometry:true});
   // Exercise mounted SPA navigation and an explicit refresh in the selected locale.
   await evaluate("document.querySelector('.control-nav a[href=\"/admin/clients\"]').click()");
   await waitForUiNavigation(tab,{url:`${origin}/admin/clients`,locale});
   console.log(JSON.stringify({browser_navigation:await evaluate("({path:location.pathname,title:document.title,heading:document.querySelector('h1')?.textContent,nav:!!document.querySelector('.control-nav'),locale:document.documentElement.lang})")}));
   assert.equal(await evaluate("location.pathname"),"/admin/clients");
   assert.equal(await evaluate("document.documentElement.lang"),locale);
   await evaluate("document.querySelector('.control-nav a[href=\"/admin\"]').click()");
   await waitForUiNavigation(tab,{url:`${origin}/admin`,locale});
   const label=await evaluate("[...document.querySelectorAll('h2')].map(h=>h.textContent).join('|')");assert.ok(label.includes(locale==="en"?"Recent jobs":"最近任务"));
  }
  // A preference changed in another tab must reload the shell, not mix
  // its old language with the newly fetched main-content language.
  await tab("Network.setCookie",{name:"runmesh_lang",value:"en",url:origin,path:"/"});
  await evaluate("document.querySelector('.control-nav a[href=\"/admin/clients\"]').click()");
  await waitForUiNavigation(tab,{url:`${origin}/admin/clients`,locale:"en"});
  assert.equal(await evaluate("document.documentElement.lang"),"en");
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
