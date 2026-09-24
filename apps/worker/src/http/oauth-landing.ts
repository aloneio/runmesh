import { ADMIN_CSRF_COOKIE } from "./constants.js";
import { centralHeaders } from "./central-boundary.js";

/** Fixed landing content: never interpolate callback parameters. The initial
 * cross-site GET has no mutation and needs no Strict cookie. After scrubbing the
 * URL, a same-origin CSRF-protected POST uses the initiating admin session. */
export function oauthLanding(): Response {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  const script = `const message=document.getElementById('status');
const query=new URLSearchParams(location.search);history.replaceState(null,'','/admin/central/oauth/callback');
const input={};let valid=true;for(const key of query.keys()){if(!['state','iss','code','error'].includes(key)||query.getAll(key).length!==1)valid=false;else input[key]=query.get(key);}
const cookie=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('${ADMIN_CSRF_COOKIE}='));
if(!valid||!cookie){message.textContent='Authorization not completed. Return to Runmesh administration and start again.';}
else{fetch('/admin/central/oauth/complete',{method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',headers:{'content-type':'application/json','x-csrf-token':cookie.slice('${ADMIN_CSRF_COOKIE}='.length)},body:JSON.stringify(input)}).then(async response=>{const result=await response.json();message.textContent=response.ok&&result.state==='linked'?'Authorization completed. You can close this page.':'Authorization was not confirmed. Check its status in Runmesh administration; do not replay this callback.';}).catch(()=>{message.textContent='Authorization result is unknown. Check its status in Runmesh administration.';});}`;
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Runmesh authorization</title><body><p id="status">Completing authorization…</p><script nonce="${nonce}">${script}</script></body></html>`, {
    headers: { ...centralHeaders, "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` },
  });
}
