import {env,runInDurableObject} from "cloudflare:test";
import {expect,it} from "vitest";
import worker from "../src/index.js";
import {requestLocale,localizeHtmlResponse,localizeUiText} from "../src/ui-locale.js";
import {randomBase64Url,sha256Hex} from "../src/security.js";
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
