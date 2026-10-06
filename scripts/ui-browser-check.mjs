import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,rm,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import WebSocket from "ws";
import { UI_BROWSER_STAGES } from "./ui-browser-contract.mjs";
import { createUiNavigationDiagnostic, probeUiNavigationServer, withUiNavigationDiagnostic } from "./ui-browser-diagnostics.mjs";
export { UI_BROWSER_STAGES };
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const navigationContextErrors = new Set([
 "Execution context was destroyed.", "Execution context was destroyed", "Cannot find context with specified id",
 "Cannot find default execution context", "Inspected target navigated or closed",
]);
const browserError = (message, stage) => new Error(`${message} (stage: ${UI_BROWSER_STAGES.includes(stage) ? stage : "browser_setup"})`);

/** Chromium's exit is a result of startup, not a reason to wait for its timer. */
export function waitForUiBrowserEndpoint(child, timeoutMs = 12000) {
 return new Promise((resolve, reject) => {
  let tail = "";
  const finish = (error, endpoint) => {
   clearTimeout(timer); child.off("error", failed); child.off("exit", exited); child.stderr.off("data", read);
   error ? reject(error) : resolve(endpoint);
  };
  const failed = () => finish(browserError("Browser process failed", "browser_startup"));
  const exited = () => finish(browserError("Browser process exited", "browser_startup"));
  const read = chunk => {
   tail = (tail + chunk).slice(-16384);
   const endpoint = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/u.exec(tail)?.[1];
   if (endpoint) finish(undefined, endpoint);
  };
  const timer = setTimeout(() => finish(browserError("Browser startup timed out", "browser_startup")), timeoutMs);
  child.once("error", failed); child.once("exit", exited); child.stderr.on("data", read);
  if (child.exitCode !== null || child.signalCode != null) exited();
 });
}

export function waitForUiBrowserSocket(socket, child, timeoutMs = 12000) {
 return new Promise((resolve, reject) => {
  const finish = error => {
   clearTimeout(timer); socket.off("open", opened); socket.off("error", failed); socket.off("close", closed); child.off("exit", exited); child.off("error", processFailed);
   error ? reject(error) : resolve();
  };
  const opened = () => finish();
  const failed = () => finish(browserError("Browser socket error", "browser_connect"));
  const closed = () => finish(browserError("Browser connection closed", "browser_connect"));
  const exited = () => finish(browserError("Browser process exited", "browser_connect"));
  const processFailed = () => finish(browserError("Browser process failed", "browser_connect"));
  const timer = setTimeout(() => finish(browserError("Browser connection timed out", "browser_connect")), timeoutMs);
  socket.once("open", opened); socket.once("error", failed); socket.once("close", closed); child.once("exit", exited); child.once("error", processFailed);
  if (child.exitCode !== null || child.signalCode != null) exited();
 });
}

/** ws emits an error when a CONNECTING socket is closed during cleanup. */
export function closeUiBrowserSocket(socket) {
 if (!socket || socket.readyState === WebSocket.CLOSED) return;
 const absorb = () => {};
 const closed = () => { socket.off("error", absorb); socket.off("close", closed); };
 socket.on("error", absorb); socket.once("close", closed);
 try { socket.close(); } catch { closed(); }
}

/** One browser connection owns its pending calls; lifecycle failures settle them immediately. */
export function createUiBrowserProtocol(socket, child, { onEvent = () => {}, stage = () => "browser_setup" } = {}) {
 const pending = new Map();
 let serial = 0, failure, targetId, sessionId;
 const settle = (id, error, result) => {
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id); clearTimeout(waiter.timer);
  error ? waiter.reject(error) : waiter.resolve(result);
 };
 const fail = message => {
  failure ??= browserError(message, stage());
  for (const id of pending.keys()) settle(id, failure);
 };
 const closed = () => fail("Browser connection closed");
 const socketFailed = () => fail("Browser socket error");
 const exited = () => fail("Browser process exited");
 const processFailed = () => fail("Browser process failed");
 const receive = raw => {
  let message;
  try { message = JSON.parse(raw); }
  catch { fail("Browser protocol response invalid"); return; }
  if (!message || typeof message !== "object") { fail("Browser protocol response invalid"); return; }
  if (message.id !== undefined) {
   const error = message.error ? Object.assign(new Error(message.error.message), { code: message.error.code }) : undefined;
   settle(message.id, error, message.result); return;
  }
  if ((message.method === "Inspector.targetCrashed" && sessionId !== undefined && message.sessionId === sessionId)
   || (message.method === "Target.targetCrashed" && targetId !== undefined && message.params?.targetId === targetId)) {
   fail("Browser renderer crashed"); return;
  }
  if ((message.method === "Target.detachedFromTarget" && sessionId !== undefined && message.params?.sessionId === sessionId)
   || (message.method === "Inspector.detached" && sessionId !== undefined && message.sessionId === sessionId)) {
   fail("Browser target detached"); return;
  }
  onEvent(message);
 };
 socket.on("message", receive); socket.on("close", closed); socket.on("error", socketFailed);
 child.on("exit", exited); child.on("error", processFailed);
 if (child.exitCode !== null || child.signalCode != null) exited();
 return {
  setTarget(id, session) { targetId = id; sessionId = session; },
  call(method, params = {}, session, timeoutMs = 12000) {
   if (failure) return Promise.reject(failure);
   return new Promise((resolve, reject) => {
    const id = ++serial, requestStage = stage();
    const timer = setTimeout(() => settle(id, browserError(`Browser operation timed out: ${method}`, requestStage)), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
     socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }), error => {
      if (error) fail("Browser request send failed");
     });
    } catch { fail("Browser request send failed"); }
   });
  },
  dispose() {
   fail("Browser closed");
   socket.off("message", receive); socket.off("close", closed); socket.off("error", socketFailed);
   child.off("exit", exited); child.off("error", processFailed);
  },
 };
}
/** A ready previous document is not evidence that the requested navigation finished. */
export async function waitForUiNavigation(tab, expected, { now = Date.now, pause = sleep, stage = "browser_setup" } = {}) {
 const deadline = now() + 5000, url = new URL(expected.url).href;
 let navigationState = "frame_pending";
 const read = (method, params) => tab(method, params, Math.max(1, deadline - now()));
 // Same-document navigation commits the live DOM URL independently of the
 // browser process's Frame.url metadata. Full loads also own a specific loader.
 const matchesFrame = frame => frame !== undefined && (expected.loaderId === undefined || frame.url === url)
  && (expected.frameId === undefined || frame.id === expected.frameId)
  && (expected.loaderId === undefined || frame.loaderId === expected.loaderId);
 const readState = async () => {
  const value = await read("Runtime.evaluate", {
   expression: "({url:location.href,locale:document.documentElement?.lang,complete:document.readyState==='complete',initialized:document.documentElement?.getAttribute('data-runmesh-navigation')==='ready',busy:document.documentElement?.getAttribute('data-runmesh-navigation-busy')==='true'})",
   returnByValue: true,
  });
  if (value.exceptionDetails) throw new Error("Browser navigation readiness evaluation failed");
  return value.result?.value;
 };
 const unmetCondition = state => state?.url !== url ? state?.busy === true ? "navigation_busy" : "location_pending"
  : state.locale !== expected.locale ? "locale_pending" : state.complete !== true ? "document_pending"
  : state.initialized !== true ? "initialization_pending" : state.busy !== false ? "navigation_busy" : undefined;
 while (now() < deadline) {
  try {
   const { frameTree } = await read("Page.getFrameTree");
   navigationState = "frame_pending";
   if (matchesFrame(frameTree.frame)) {
    const condition = unmetCondition(await readState());
    navigationState = condition ?? "frame_changed";
    if (condition === undefined) {
     const current = (await read("Page.getFrameTree")).frameTree.frame;
     if (matchesFrame(current) && current.loaderId === frameTree.frame.loaderId) {
      const confirmed = unmetCondition(await readState());
      navigationState = confirmed ?? "deadline_exhausted";
      if (confirmed === undefined && now() < deadline) return;
     }
    }
   }
  } catch (error) {
   if (error?.code !== -32000 || !navigationContextErrors.has(error.message)) throw error;
   navigationState = "context_changed";
  }
  await pause(Math.min(50, Math.max(0, deadline - now())));
 }
 throw browserError(`Browser navigation readiness timed out after 5000 ms\nRUNMESH_E2E_UI_NAVIGATION_STATE=${navigationState}`, stage);
}
/** Isolated local-test browser only. Never opens a user's browser profile. */
export async function checkUiWithChromium(origin,cookie,output){
 assert.equal(new URL(origin).hostname,"127.0.0.1");
 const profile=await mkdtemp(join(tmpdir(),"runmesh-ui-browser-"));
 const child=spawn(process.env.RUNMESH_CHROMIUM_EXECUTABLE ?? "/usr/bin/chromium",["--headless","--no-sandbox","--disable-dev-shm-usage","--no-first-run","--disable-background-networking","--remote-debugging-address=127.0.0.1","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:["ignore","ignore","pipe"]});
 let socket,protocol,stage="browser_setup";
 const navigationDiagnostic=createUiNavigationDiagnostic();
 try{
  const endpoint=await waitForUiBrowserEndpoint(child);
  socket=new WebSocket(endpoint);await waitForUiBrowserSocket(socket,child);
  const exceptions=[],requests=[];
  protocol=createUiBrowserProtocol(socket,child,{stage:()=>stage,onEvent:message=>{navigationDiagnostic.observe(message);if(message.method==="Runtime.exceptionThrown")exceptions.push(message.params.exceptionDetails.text);else if(message.method==="Network.requestWillBeSent")requests.push(message.params.request.url);}});
  const {call}=protocol;
  const {targetId}=await call("Target.createTarget",{url:"about:blank"});const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
  protocol.setTarget(targetId,sessionId);
  const tab=(m,p,timeoutMs)=>call(m,p,sessionId,timeoutMs);
  const evaluate=async(expression)=>{const value=await tab("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(JSON.stringify(value.exceptionDetails));return value.result.value;};
  await tab("Inspector.enable");await tab("Page.enable");await tab("Runtime.enable");await tab("Network.enable");
  await tab("Network.setCookies",{cookies:cookie.split(";").map(part=>{const at=part.indexOf("=");return {name:part.slice(0,at).trim(),value:part.slice(at+1),url:origin,path:"/",secure:true,httpOnly:false,sameSite:"Lax"};})});
  await tab("Emulation.setDeviceMetricsOverride",{width:1365,height:1000,deviceScaleFactor:1,mobile:false});
  const reports=[];
  for(const locale of ["en","zh-CN"]){
   stage="dashboard_navigation";
   const url=`${origin}/admin?lang=${locale}`;
   navigationDiagnostic.begin(url,locale,sessionId);
   const navigation=await tab("Page.navigate",{url});
   assert.equal(navigation.errorText,undefined);assert.ok(navigation.loaderId);
   await waitForUiNavigation(tab,{url,locale,frameId:navigation.frameId,loaderId:navigation.loaderId},{stage});
   stage="dashboard_initial";
   const first=await evaluate(`(()=>{const panel=[...document.querySelectorAll('.panel')].find(p=>/^(Your AI connections|你的 AI 连接|Recent jobs|最近任务)$/.test(p.querySelector('h2')?.textContent||''));if(!panel)throw Error('Missing dashboard activity panel');window.__uiPanel=panel;window.__uiMutations=0;new MutationObserver(m=>window.__uiMutations+=m.length).observe(panel,{childList:true,subtree:true,characterData:true,attributes:true});const r=panel.getBoundingClientRect();return {lang:document.documentElement.lang,heading:panel.querySelector('h2').textContent,text:panel.textContent,top:r.top,height:r.height,opacity:getComputedStyle(panel).opacity}})()`);
   const requestsBefore=requests.length;await sleep(1000);stage="dashboard_idle";
   const second=await evaluate(`(()=>{const p=window.__uiPanel,r=p.getBoundingClientRect();return {lang:document.documentElement.lang,text:p.textContent,top:r.top,height:r.height,opacity:getComputedStyle(p).opacity,mutations:window.__uiMutations,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
   assert.equal(first.lang,locale);assert.equal(first.text,second.text);assert.equal(first.top,second.top);assert.equal(first.height,second.height);assert.equal(second.opacity,"1");assert.equal(second.mutations,0);assert.equal(second.overflow,false);
   assert.equal(requests.slice(requestsBefore).filter(url=>new URL(url).pathname.startsWith("/admin")).length,0);
   if(output){await mkdir(output,{recursive:true});const image=await tab("Page.captureScreenshot",{format:"png"});await writeFile(join(output,`dashboard-${locale}.png`),Buffer.from(image.data,"base64"));}
   reports.push({locale,idle_dom_mutations:second.mutations,idle_admin_requests:0,stable_panel_geometry:true});
   // Exercise mounted SPA navigation and an explicit refresh in the selected locale.
   stage="clients_navigation";
   navigationDiagnostic.begin(`${origin}/admin/clients`,locale,sessionId);
   await evaluate("document.querySelector('.control-nav a[href=\"/admin/clients\"]').click()");
   await waitForUiNavigation(tab,{url:`${origin}/admin/clients`,locale},{stage});
   stage="clients_details";
   console.log(JSON.stringify({browser_navigation:await evaluate("({path:location.pathname,title:document.title,heading:document.querySelector('h1')?.textContent,nav:!!document.querySelector('.control-nav'),locale:document.documentElement.lang})")}));
   assert.equal(await evaluate("location.pathname"),"/admin/clients");
   assert.equal(await evaluate("document.documentElement.lang"),locale);
   stage="dashboard_return";
   navigationDiagnostic.begin(`${origin}/admin`,locale,sessionId);
   await evaluate("document.querySelector('.control-nav a[href=\"/admin\"]').click()");
   await waitForUiNavigation(tab,{url:`${origin}/admin`,locale},{stage});
   stage="dashboard_headings";
   const labels=await evaluate("[...document.querySelectorAll('h2')].map(h=>h.textContent)");assert.ok(labels.includes(first.heading));
  }
  // A preference changed in another tab must reload the shell, not mix
  // its old language with the newly fetched main-content language.
  stage="locale_navigation";
  navigationDiagnostic.begin(`${origin}/admin/clients`,"en",sessionId);
  await tab("Network.setCookie",{name:"runmesh_lang",value:"en",url:origin,path:"/"});
  await evaluate("document.querySelector('.control-nav a[href=\"/admin/clients\"]').click()");
  await waitForUiNavigation(tab,{url:`${origin}/admin/clients`,locale:"en"},{stage});
  stage="locale_details";
  assert.equal(await evaluate("document.documentElement.lang"),"en");
  stage="mobile_layout";
  await tab("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),true);
  assert.deepEqual(exceptions,[]);
  stage="browser_close";
  await call("Browser.close").catch(()=>{});
  console.log(JSON.stringify({browser_ui_check:reports,mobile_horizontal_overflow:false,script_exceptions:exceptions.length}));
  return reports;
 }catch(error){
  const diagnostic=navigationDiagnostic.diagnostic();
  if(diagnostic&&["dashboard_navigation","clients_navigation","dashboard_return","locale_navigation"].includes(stage)){
   try { diagnostic.server_probes=await probeUiNavigationServer(origin,cookie); } catch { /* Keep the original browser failure if the fixture cannot be probed. */ }
   throw withUiNavigationDiagnostic(error,diagnostic);
  }
  throw error;
 }finally{
  protocol?.dispose();closeUiBrowserSocket(socket);
  if(child.pid!==undefined&&child.exitCode===null){child.kill("SIGTERM");await Promise.race([new Promise(r=>child.once("exit",r)),sleep(3000)]);if(child.exitCode===null)child.kill("SIGKILL");}
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
}
