import { ADMIN_CSRF_COOKIE } from "./constants.js";
import type { UiLocale } from "../contracts/locale.js";
import { oauthLandingDocument } from "../admin/oauth-view.js";
import { htmlHeaders } from "./html-response.js";

/** Fixed landing content: never interpolate callback parameters. The initial
 * cross-site GET has no mutation and needs no Strict cookie. After scrubbing the
 * URL, a same-origin CSRF-protected POST uses the initiating admin session. */
export function oauthLanding(locale: UiLocale = "en"): Response {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  const path = "/admin/central/connections/";
  const script = `const message=document.getElementById('status'),panel=document.querySelector('[data-oauth-callback]'),title=document.getElementById('oauth-title');
const failed=kind=>{panel.setAttribute('aria-busy','false');title.textContent=panel.dataset.failed;message.textContent=panel.dataset[kind];};
const query=new URLSearchParams(location.search);history.replaceState(null,'','${path}callback');
const input={};let valid=true;for(const key of ['state','iss','code','error']){const values=query.getAll(key);if(values.length>1)valid=false;else if(values.length===1)input[key]=values[0];}
const cookie=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('${ADMIN_CSRF_COOKIE}='));
if(!valid||!cookie){failed('restart');}
else{fetch('${path}complete',{method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(25000),headers:{'content-type':'application/json','x-csrf-token':cookie.slice('${ADMIN_CSRF_COOKIE}='.length)},body:JSON.stringify(input)}).then(async response=>{const result=await response.json();if(response.ok&&result.state==='linked'&&typeof result.profile_id==='string'&&result.profile_id){location.replace('/admin/central?connected='+encodeURIComponent(result.profile_id));return;}failed(input.error==='access_denied'?'cancelled':'unconfirmed');}).catch(()=>{failed('unconfirmed');});}`;
  const headers = htmlHeaders();
  headers.set("content-language", locale);
  headers.set("content-security-policy", headers.get("content-security-policy")!.replace("script-src 'none'", `script-src 'nonce-${nonce}'`).replace("form-action 'self'", "form-action 'none'"));
  return new Response(oauthLandingDocument(locale).replace("</body>", `<script nonce="${nonce}">${script}</script></body>`), { headers });
}
