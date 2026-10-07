import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { adminDocument } from '../apps/worker/dist/admin/layout.js';
import { centralPage } from '../apps/worker/dist/admin/central-view.js';
import { oauthLanding } from '../apps/worker/dist/http/oauth-landing.js';
import { ADMIN_CSRF_COOKIE } from '../apps/worker/dist/http/constants.js';
import { parseProfileCommand } from '../apps/worker/dist/contracts/connector-values.js';
import { skillInstallation } from '../apps/worker/dist/domain/skills/install.js';
import { overviewPage } from '../apps/worker/dist/admin/dashboard-views.js';
import { clientsPage } from '../apps/worker/dist/admin/client-views.js';
import { localizeUiText } from '../apps/worker/dist/i18n/legacy-text.js';
import { requestLocale } from '../apps/worker/dist/i18n/locale.js';

/** Isolated HTTP product fixture with explicit OAuth, discovery and Skill faults. */
export async function createProductFixture() {
 const digest='a'.repeat(64), toolVersion='c'.repeat(64);
 const profiles=[], library=[], requests=[], exceptions=[];
 // Fault controls belong to the simulated upstream that owns their behavior.
 const controls = {
  library: { unavailable: false },
  oauth: { rejectStart: false, rejectComplete: false, delayed: undefined, authorizeDiscoveryOnComplete: false },
  discovery: { conflict: false, reject: false, invalidReceipt: false, delayed: undefined, rejectedProfile: undefined, after: undefined, failRefreshAfterRejection: false, uncertainAuthorization: false },
  skills: { afterInstallation: undefined },
 };
 let oauthProfileId;
 const catalogs=new Map();
 const server=createServer(async(req,res)=>{
  try {
   const url=new URL(req.url,'http://127.0.0.1');
   const locale=requestLocale(new Request(url,{headers:{cookie:req.headers.cookie??''}}));
   if(url.pathname==='/oauth-fixture'){res.statusCode=302;res.setHeader('location','/admin/central/connections/callback?state=fixture-state&code=fixture-code&iss=https://login.provider.com&scope=read&authuser=0');res.end();return;}
   if(url.pathname==='/late-oauth-fixture'){res.setHeader('content-type','text/html');res.end('<p>Unexpected detached OAuth redirect</p>');return;}
   if(url.pathname==='/admin/central/connections/callback'){const page=oauthLanding(locale);for(const [k,v] of page.headers)res.setHeader(k,v);res.end(await page.text());return;}
   if(url.pathname==='/admin') {res.setHeader('content-type','text/html');res.end(adminDocument('Dashboard',overviewPage({clients:[],runners:[],jobs:[],snapshot:{runners:[],jobs:[]},notices:[]},'fixture-csrf'),'dashboard'));return;}
   if(url.pathname==='/admin/central') {res.setHeader('set-cookie',ADMIN_CSRF_COOKIE+'=fixture-csrf; Path=/; SameSite=Strict; Secure');res.setHeader('content-type','text/html');res.end(adminDocument('MCP & Skill',centralPage('fixture-csrf',true,true),'central').replace('<html lang="en">','<html lang="'+locale+'">'));return;}
   if(url.pathname==='/admin/clients') {
    res.setHeader('content-type','text/html');
    const content=clientsPage({clients:[],runners:[],jobs:[],snapshot:{},notices:[]},'fixture-csrf',!url.searchParams.has('native-only'));
    res.end(adminDocument('MCP clients',content.replace('>Computer permissions<','>'+localizeUiText('Computer permissions',locale)+'<'),'clients').replace('<html lang="en">','<html lang="'+locale+'">'));return;
   }
   const raw=[];for await(const part of req)raw.push(part);
   const body=raw.length?JSON.parse(Buffer.concat(raw).toString()):undefined;
   requests.push({path:url.pathname,method:req.method,body});
   let value, code=200;const path=url.pathname.replace('/admin/central/',''),[kind,id]=path.split('/');
   if(kind==='profiles'&&!id){value={state:'listed',profiles,next_after:null};if(controls.library.unavailable){code=503;value={state:'unavailable'};}}
   else if(kind==='profiles'){
    if(body.action==='connect'&&!parseProfileCommand({...body,profile_id:id})){code=400;value={error:{code:'central_invalid_request',operation_state:'not_started'}};}
    else if(body.action==='connect'){const p={profile_id:id,connector_id:body.connector_id,display_name:body.display_name,endpoint:body.endpoint,revision:1,enabled:false,credential:null,authentication:body.authentication};profiles.push(p);value={state:'written',profile:p};}
    else{const p=profiles.find(p=>p.profile_id===id);assert.equal(body.expected_revision,p.revision);p.revision++;if(body.action==='enable'||body.action==='disable')p.enabled=body.action==='enable';value={state:'written',profile:p};}
   }else if(kind==='connections'){
    assert.equal(req.headers['x-csrf-token'],'fixture-csrf');
    if(id==='complete'&&!body.error&&controls.oauth.authorizeDiscoveryOnComplete){controls.discovery.reject=false;controls.oauth.authorizeDiscoveryOnComplete=false;}
    if(id==='begin'){
     const pending=controls.oauth.delayed;if(pending)await pending;
     if(controls.oauth.rejectStart){code=503;value={error:{code:'oauth_provider_unsupported',operation_state:'not_started'}};}
     else{
      oauthProfileId=body.profile_id;
      value={state:'started',profile_id:oauthProfileId,authorization_url:pending?'/late-oauth-fixture':'/oauth-fixture'};
     }
    }else if(id==='complete'){
     if(body.error){assert.deepEqual(body,{state:'cancel-state',error:'access_denied'});code=503;value={error:{code:'oauth_reauthorization_required'}};}
     else{
      assert.deepEqual(body,{state:'fixture-state',iss:'https://login.provider.com',code:'fixture-code'});
      if(controls.oauth.rejectComplete){code=503;value={error:{code:'oauth_unavailable',operation_state:'unknown'}};}
      else{
       assert.equal(typeof oauthProfileId,'string','An OAuth callback must follow a successful begin');
       value={state:'linked',profile_id:oauthProfileId};oauthProfileId=undefined;
      }
     }
    }
    else value={state:'revoked',profile_id:body.profile_id};
   }else if(kind==='skill-installations'){
    const installation=skillInstallation(body);
    if(!installation){code=400;value={error:{code:'skill_invalid_package',operation_state:'not_started'}};}
    else{
     const {bundle,revision}=installation,item=library.find(s=>s.head.skill_id===bundle.skill_id);
     if((item?.head.revision??0)!==revision){code=409;value={state:'conflict',skill_id:bundle.skill_id,current_revision:item.head.revision};}
     else{const entry={head:{skill_id:bundle.skill_id,revision:revision+1,enabled:true,staged_digest:digest,active_digest:digest},bundle:{...bundle,digest}};if(item)library.splice(library.indexOf(item),1,entry);else library.push(entry);value={state:'installed',skill_id:bundle.skill_id,name:bundle.name,revision:entry.head.revision,digest};const change=controls.skills.afterInstallation;controls.skills.afterInstallation=undefined;change?.(entry);}
    }
   }else if(kind==='discovery'){
    if(controls.discovery.delayed)await controls.discovery.delayed;
    assert.equal(body.expected_revision,catalogs.get(id)?.head.revision??0);
    if(controls.discovery.conflict){code=409;value={state:'conflict',current_revision:body.expected_revision+1};}
    else if(controls.discovery.invalidReceipt)value={state:'listed',catalogs:[],next_after:null};
    else if(controls.discovery.uncertainAuthorization){code=503;value={error:{code:'remote_authorization_required',operation_state:'unknown'}};}
    else if(controls.discovery.reject||id===controls.discovery.rejectedProfile){value={state:'authorization_required'};if(controls.discovery.failRefreshAfterRejection)controls.library.unavailable=true;}
    else{
    const head={profile_id:id,revision:body.expected_revision+1,observed_digest:digest,approved_digest:digest,approved_names:['search']};
    const snapshot={digest,tools:[{tool_id:'tool-search',public_name:'search',version:toolVersion,definition:{name:'search',description:'<img src=x onerror=alert(1)>',inputSchema:{type:'object',properties:{query:{type:'string'}}},annotations:{readOnlyHint:true}}}]};
    catalogs.set(id,{state:'found',head,snapshot,changes:[{name:'search',state:'added'}]});value={state:'written',head:structuredClone(head)};
    const change=controls.discovery.after;controls.discovery.after=undefined;change?.(id);}
   }else if(kind==='catalogs'){
    value=catalogs.get(id);if(!value)value={state:'empty'};
    else if(body)throw new Error('Manual approval is not part of the connection flow');
    else if(url.searchParams.get('snapshot')===value.approved?.digest){value={...value,snapshot:value.approved};}
   }else if(kind==='skills'&&!id)value={state:'listed',skills:library.map(s=>{const selected=s.published?.digest===s.head.active_digest?s.published:s.bundle;return{head:s.head,summary:{name:selected.name,description:selected.description}};}),next_after:null};
   else if(kind==='skills'){
    const item=library.find(s=>s.head.skill_id===id);
    if(!body){if(item)value={state:'found',head:item.head,bundle:url.searchParams.get('digest')===item.published?.digest?item.published:item.bundle};else{code=404;value={state:'missing'};}}
    else if(body.action==='preview')value={state:'previewed',bundle:{skill_id:id,name:'research',description:'Research fixture',source:body.source,license:body.license,files:body.files,digest}};
    else if(body.action==='stage'){assert.equal(body.expected_revision,0);const entry={head:{skill_id:id,revision:1,enabled:false,staged_digest:digest,active_digest:null},bundle:{skill_id:id,name:'research',description:'Research fixture',source:body.source,license:body.license,files:body.files,digest}};library.push(entry);value={state:'written',head:entry.head};}
    else{
     assert.equal(body.expected_revision,item.head.revision);assert.ok(['activate','disable'].includes(body.action));
     if(body.action==='activate'){assert.equal(body.digest,item.bundle.digest);item.published=structuredClone(item.bundle);}
     item.head={...item.head,revision:item.head.revision+1,enabled:body.action==='activate',active_digest:body.action==='activate'?body.digest:item.head.active_digest};
     value={state:'written',head:item.head};
    }
   }else if(kind==='grants'||kind==='toolsets'){throw new Error('Retired client access API must not be called');
   }else{code=404;value={state:'missing'};}
   res.statusCode=code;res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify(value));
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:{code:'fixture_failed'}}));exceptions.push(String(error));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 return { digest, toolVersion, profiles, library, requests, exceptions, catalogs, controls, origin, close: () => new Promise(resolve => server.close(resolve)) };
}
