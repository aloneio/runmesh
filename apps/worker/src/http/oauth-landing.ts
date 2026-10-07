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
let active=true;window.addEventListener('beforeunload',()=>{active=false;});
const failed=kind=>{if(!active)return;panel.setAttribute('aria-busy','false');title.textContent=panel.dataset.failed;message.textContent=panel.dataset[kind];};
const query=new URLSearchParams(location.search);history.replaceState(null,'','${path}callback');
const input={};let valid=true;for(const key of ['state','iss','code','error']){const values=query.getAll(key);if(values.length>1)valid=false;else if(values.length===1)input[key]=values[0];}
const failureKind=(status,result)=>{const error=result?.error;if(error?.operation_state!=='not_started')return 'unconfirmed';
if(status===403&&error.code==='central_admin_denied')return 'session';
if(status===403&&error.code==='oauth_denied')return 'denied';
if(status===400&&error.code==='oauth_invalid_callback')return 'expired';
if(status===400&&error.code==='oauth_invalid_request')return 'restart';
if(status===409&&error.code==='oauth_conflict')return 'changed';
if(status===503){if(error.code==='oauth_configuration_required')return 'configuration';if(error.code==='oauth_provider_unsupported')return 'provider';if(error.code==='oauth_reauthorization_required')return input.error==='access_denied'?'cancelled':'restart';if(error.code==='oauth_unavailable'||error.code==='central_authority_unavailable')return 'unavailable';}
return 'unconfirmed';};
const cookie=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('${ADMIN_CSRF_COOKIE}='));
if(!valid){failed('restart');}
else if(!cookie){failed('session');}
else{fetch('${path}complete',{method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(25000),headers:{'content-type':'application/json','x-csrf-token':cookie.slice('${ADMIN_CSRF_COOKIE}='.length)},body:JSON.stringify(input)}).then(async response=>{if(!active){void response.body?.cancel().catch(()=>undefined);return;}const result=await response.json();if(!active)return;if(response.ok&&result.state==='linked'&&typeof result.profile_id==='string'&&result.profile_id){location.replace('/admin/central?connected='+encodeURIComponent(result.profile_id));return;}failed(failureKind(response.status,result));}).catch(()=>{failed('unconfirmed');});}`;
  const headers = htmlHeaders();
  headers.set("content-language", locale);
  headers.set("content-security-policy", headers.get("content-security-policy")!.replace("script-src 'none'", `script-src 'nonce-${nonce}'`).replace("form-action 'self'", "form-action 'none'"));
  return new Response(oauthLandingDocument(locale).replace("</body>", `<script nonce="${nonce}">${script}</script></body>`), { headers });
}
