import {env,runInDurableObject} from "cloudflare:test";
import {expect,it} from "vitest";
import worker from "../src/index.js";
import {requestLocale,localizeHtmlResponse,localizeUiText} from "../src/ui-locale.js";
import {randomBase64Url,sha256Hex} from "../src/security.js";
import {enrollmentDocument} from "../src/admin/enrollment-view.js";
import {clientDetailPage} from "../src/admin/client-views.js";
import {jobTable,mcpCallTable} from "../src/admin/tables.js";
const request=(lang="en",headers:Record<string,string>={})=>new Request(`https://worker.test/admin?lang=${lang}`,{headers});
it("locale priority is explicit query, exact cookie, then quality-ranked browser preferences",()=>{
 expect(requestLocale(request("zh-CN"))).toBe("zh-CN");
 expect(requestLocale(request("en",{cookie:"runmesh_lang=zh-CN"}))).toBe("en");
 expect(requestLocale(new Request("https://worker.test/admin",{headers:{cookie:"fake_runmesh_lang=zh-CN; runmesh_lang=en"}}))).toBe("en");
 expect(requestLocale(new Request("https://worker.test/admin",{headers:{"accept-language":"zh;q=0.1,en;q=0.9"}}))).toBe("en");
});
it("server output renders once and preserves escaped user text, code, secrets, script bytes and attributes",async()=>{
 const html='<html lang="en"><head><title>Dashboard</title><script nonce="abc">let x="Recent jobs";</script></head><body><h1>Recent jobs</h1><p>Client Routing &amp; Status</p><span data-no-i18n>Dashboard &lt;img src=x onerror=bad&gt;</span><pre>Recent jobs &lt;b&gt;中文&lt;/b&gt;</pre><input value="Recent jobs" placeholder="Display name"><p>7 days</p><h2>Job logs</h2></body></html>';
 for(const lang of ["en","zh-CN"]){
  const response=localizeHtmlResponse(request(lang),new Response(html,{headers:{"content-type":"text/html","content-security-policy":"script-src 'nonce-abc'"}}));const result=await response.text();
  expect(response.headers.get("content-language")).toBe(lang);expect(response.headers.get("cache-control")).toBe("no-store");
  expect(result).toContain('<script nonce="abc">let x="Recent jobs";</script>');
  expect(result).toContain('Dashboard &lt;img src=x onerror=bad&gt;');expect(result).not.toContain('<img src=x');expect(result).not.toContain('&amp;lt;');
  expect(result).toContain('value="Recent jobs"');expect(result).toContain('<pre>Recent jobs &lt;b&gt;中文&lt;/b&gt;</pre>');
  expect(result).toContain(lang==="en"?'<h1>Recent jobs</h1>':'<h1>最近任务</h1>');
  expect(result).toContain(lang==="en"?'Client Routing &amp; Status':'客户端路由与状态');
  expect(result).toContain(lang==="en"?'7 days':'7 天');
 }
});
async function fixture(){
 const id=env.REGISTRY.idFromName(`locale-${crypto.randomUUID()}`),stub=env.REGISTRY.get(id),session=randomBase64Url(),csrf=randomBase64Url();
 const sessionHash=await sha256Hex(session),csrfHash=await sha256Hex(csrf);
 await runInDurableObject(stub,(instance)=>{const now=Date.now();instance.setupAdmin("locale-test-password",now);instance.createAdminSession(sessionHash,csrfHash,now+60000,now,1);instance.registerRunner("locale-runner","a".repeat(64),now,undefined,"dedicated_user");instance.createMcpClient({client_id:"locale-client",label:"custom-client",secret_verifier:"b".repeat(64),secret_prefix:"test",scopes:["coding:read"]},now);});
 return (path:string,lang:string)=>worker.fetch(new Request(`https://worker.test${path}${path.includes("?")?"&":"?"}lang=${lang}`,{headers:{cookie:`__Host-runmesh_admin_session=${session}; __Host-runmesh_admin_csrf=${csrf}`}}),{...env,REGISTRY:{idFromName:()=>id,get:()=>stub} as unknown as typeof env.REGISTRY},{} as ExecutionContext);
}
function visible(html:string):string{return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,"").replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi,"").replace(/<div class="language-switch"[^>]*>[\s\S]*?<\/div>/g,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ");}
it("all primary authenticated pages and lazy history controls render a single chosen language",async()=>{
 const open=await fixture();
 for(const path of ["/admin","/admin/runners","/admin/clients","/admin/settings","/admin/clients/locale-client","/admin/runners/locale-runner","/admin/runners/locale-runner?history=all&limit=10"]){
  const en=await open(path,"en");expect(en.status,path).toBe(200);const english=visible(await en.text());expect(english,path).not.toMatch(/[\u4e00-\u9fff]/);
  const zh=await open(path,"zh-CN");expect(zh.status,path).toBe(200);const chinese=visible(await zh.text());expect(chinese,path).toMatch(/[\u4e00-\u9fff]/);
  for(const label of ["Recent jobs","Cloud recording","History to load","Save history settings","Latest records","Create MCP client","Upload interval","Each base scope has a distinct ceiling"])expect(chinese,path).not.toContain(label);
 }
});

it("unknown data-like text cannot resolve Object prototype methods as translations",()=>{
 for(const value of ["constructor","__proto__","toString","valueOf"])expect(localizeUiText(value,"zh-CN")).toBe(value);
});

it("compound browser titles translate every known UI segment, not only the first label",()=>{
 for(const [en,zh] of [
  ["Runmesh · Agent Control Plane login","Runmesh · 智能体控制平面登录"],
  ["Dashboard · Runmesh · Agent Control Plane","仪表盘 · Runmesh · 智能体控制平面"],
  ["Runmesh · Agent Control Plane enrollment","Runmesh · 智能体控制平面注册"],
 ]){expect(localizeUiText(en!,"zh-CN")).toBe(zh);expect(localizeUiText(en!,"en")).toBe(en);}
});
it("the public login response has a fully localized browser title",async()=>{
 const id=env.REGISTRY.idFromName(`title-login-${crypto.randomUUID()}`),stub=env.REGISTRY.get(id);
 await runInDurableObject(stub,instance=>{instance.setupAdmin("synthetic-title-admin",Date.now());});
 const response=await worker.fetch(new Request("https://worker.test/login?lang=zh-CN"),{...env,REGISTRY:{idFromName:()=>id,get:()=>stub} as unknown as typeof env.REGISTRY},{} as ExecutionContext);
 expect(response.status).toBe(200);
 const html=await response.text(),title=/<title>([^<]+)<\/title>/.exec(html)?.[1];
 expect(title).toBe("Runmesh · 智能体控制平面登录");
 expect(response.headers.get("content-language")).toBe("zh-CN");
});

it("I18N01 translations preserve restricted defaults and destructive cleanup scope",()=>{
 for(const value of ["The default is dedicated_user; privileged_host is an advanced, explicitly confirmed option.","The default is dedicated_user; privileged_host is an advanced, explicitly confirmed option. The install step runs only after enrollment succeeds."]){
  const translated=localizeUiText(value,"zh-CN");
  expect(translated).toContain("默认");expect(translated).toContain("dedicated_user");expect(translated).toContain("明确确认");
  expect(translated).not.toContain("推荐使用 privileged_host");
 }
 expect(localizeUiText("Disabled","zh-CN")).toBe("禁用");
 expect(localizeUiText("stale","zh-CN")).toBe("状态陈旧");
 const removal="Run the command for the local OS to stop the managed service and remove the Runmesh installation, configuration, local job history, logs and supported legacy remnants. Project workspaces are preserved. Delete the Runner record separately from the administrator console when you no longer need its history.";
 for(const term of ["任务历史","日志","工作区","保留"])expect(localizeUiText(removal,"zh-CN")).toContain(term);
});

for(const executionMode of ["dedicated_user","privileged_host"] as const)for(const bootstrap of [false,true]){
 it(`I18N02 enrollment stays single-locale: ${executionMode}, hosted=${bootstrap}`,async()=>{
  const original=enrollmentDocument({publicBase:"https://example.test",runnerId:"runner-i18n",code:"synthetic-code-DO-NOT-USE",csrf:"synthetic-csrf",reEnroll:false,bootstrap,executionMode,maxValidityDays:3650,enrollment:{expires_at_ms:1900000000000}});
  for(const locale of ["en","zh-CN"]){
   const output=await localizeHtmlResponse(request(locale),new Response(original,{headers:{"content-type":"text/html"}})).text();
   const text=visible(output.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gu,""));
   if(locale==="en")expect(text).not.toMatch(/[\u4e00-\u9fff]/u);
   else for(const phrase of ["Manual Runner enrollment","The installer verifies","Selected execution mode:","The default is dedicated_user","This code is valid until","You must keep","Run the command for the local OS"])expect(text).not.toContain(phrase);
   expect([...output.matchAll(/<pre\b[^>]*>[\s\S]*?<\/pre>/gu)].map(x=>x[0])).toEqual([...original.matchAll(/<pre\b[^>]*>[\s\S]*?<\/pre>/gu)].map(x=>x[0]));
  }
 });
}

it("I18N03 regional query overrides cookie; malformed language ranges are ignored",()=>{
 expect(requestLocale(request("en-US",{cookie:"runmesh_lang=zh-CN"}))).toBe("en");
 expect(requestLocale(request("zh-Hans",{cookie:"runmesh_lang=en"}))).toBe("zh-CN");
 expect(requestLocale(new Request("https://worker.test/admin",{headers:{"accept-language":"zh;q=2,en;q=1"}}))).toBe("en");
 expect(requestLocale(new Request("https://worker.test/admin",{headers:{"accept-language":"zhongwen,en;q=0.9"}}))).toBe("en");
});

it("I18N04 no-translation attributes cover void elements and translate=no subtrees",async()=>{
 const original='<html><body><input data-no-i18n title="Dashboard" placeholder="Display name" value="Login"><div translate="no" title="Dashboard">Recent jobs <span>Settings</span></div><h1>Recent jobs</h1></body></html>';
 const output=await localizeHtmlResponse(request("zh-CN"),new Response(original,{headers:{"content-type":"text/html"}})).text();
 expect(output).toContain('<input data-no-i18n title="Dashboard" placeholder="Display name" value="Login">');
 expect(output).toContain('<div translate="no" title="Dashboard">Recent jobs <span>Settings</span></div>');
 expect(output).toContain('<h1>最近任务</h1>');
});

it("I18N05 terminal Job and audit states plus durations have translations",()=>{
 for(const [source,expected] of [["cancelled","已取消"],["interrupted","已中断"],["ok","成功"],["error","错误"],["17 ms","17 毫秒"]])expect(localizeUiText(source!,"zh-CN")).toBe(expected);
});

it("I18N06 explicit locale persists before browser scripts without replacing session cookies",async()=>{
 const response=localizeHtmlResponse(request("zh-Hans"),new Response('<html lang="en"><body>Dashboard</body></html>',{headers:{"content-type":"text/html","set-cookie":"existing=preserved; Secure"}}));
 expect(response.headers.get("set-cookie")).toContain("runmesh_lang=zh-CN");
 expect(response.headers.get("set-cookie")).toContain("existing=preserved");
 await response.text();
});

it("I18N07 numeric entities and streaming chunks translate without corrupting protected text",async()=>{
 const source='<html><body><h1>&#68;ashboard</h1><h2>Recent jobs</h2><span data-no-i18n>&#68;ashboard &lt;b&gt;</span></body></html>';
 const bytes=new TextEncoder().encode(source);
 const stream=new ReadableStream<Uint8Array>({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}});
 const output=await localizeHtmlResponse(request("zh-CN"),new Response(stream,{headers:{"content-type":"text/html"}})).text();
 expect(output).toContain('<h1>仪表盘</h1>');expect(output).toContain('<h2>最近任务</h2>');
 expect(output).toContain('&#68;ashboard &lt;b&gt;');
});

it("I18N08 UI-like user labels and identifiers are never translated as interface copy",async()=>{
 const detail=clientDetailPage({client_id:"Settings",label:"Dashboard",revoked_at_ms:null,scopes:["coding:read","coding:exec"],active_runner_id:null},[],[],"synthetic-csrf");
 const jobs=jobTable([{job_id:"running",workspace_id:"Settings",created_by_client_id:"failed",status:"cancelled"}]);
 const calls=mcpCallTable([{client_id:"Read",method:"shell",workspace_id:"Settings",job_id:"running",status:"error",error_code:"permission_denied",duration_ms:17}]);
 const translated=await localizeHtmlResponse(request("zh-CN"),new Response(`<html><body>${detail}${jobs}${calls}</body></html>`,{headers:{"content-type":"text/html"}})).text();
 expect(translated).toContain('<h1 class="detail-title" data-no-i18n>Dashboard</h1>');
 expect(translated).toContain('<span class="workspace-pill" data-no-i18n>Settings</span>');
 expect(translated).toContain('<td class="mono job-id-cell" data-no-i18n>running</td>');
 expect(translated).toContain('<td class="mono font-12" data-no-i18n>Read</td>');
 expect(translated).toContain('<span data-no-i18n> · permission_denied</span>');
 expect(translated).toContain('已取消');expect(translated).toContain('错误');expect(translated).toContain('17 毫秒');
 expect(translated).toContain('读取、执行');
});

it("I18N09 long untranslated text and non-HTML responses remain intact",async()=>{
 const long='x'.repeat(70000),source=`<html><body><div>${long}</div><p>Settings</p><code>Dashboard</code><p>Recent jobs</p></body></html>`;
 const result=await localizeHtmlResponse(request("zh-CN"),new Response(source,{headers:{"content-type":"text/html"}})).text();
 expect(result).toContain(`<div>${long}</div><p>设置</p><code>Dashboard</code><p>最近任务</p>`);
 const json=Response.json({message:"Recent jobs"});expect(localizeHtmlResponse(request("zh-CN"),json)).toBe(json);
});
