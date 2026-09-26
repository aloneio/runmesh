import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { adminDocument } from '../apps/worker/dist/admin/layout.js';
import { centralPage } from '../apps/worker/dist/admin/central-view.js';
import { oauthLanding } from '../apps/worker/dist/http/oauth-landing.js';
import { ADMIN_CSRF_COOKIE } from '../apps/worker/dist/http/constants.js';
import { productOverviewPage } from '../apps/worker/dist/admin/dashboard-views.js';

/** Isolated browser fixtures exercise the shipped UI, never a user browser or external service. */
export async function checkGuidedProduct(executable) {
 const digest='a'.repeat(64), toolVersion='c'.repeat(64);
 const profiles=[], library=[], requests=[], exceptions=[];
 let conflict=false, failLibrary=false, rejectDiscovery=false;
 const catalogs=new Map();
 const server=createServer(async(req,res)=>{
  try {
   const url=new URL(req.url,'http://127.0.0.1');
   if(url.pathname==='/oauth-fixture'){res.statusCode=302;res.setHeader('location','/admin/central/connections/callback?state=fixture-state&code=fixture-code&iss=https://login.provider.com&scope=read&authuser=0');res.end();return;}
   if(['/admin/central/connections/callback','/admin/central/oauth/callback'].includes(url.pathname)){const page=oauthLanding(url.pathname.includes('/connections/'));for(const [k,v] of page.headers)res.setHeader(k,v);res.end(await page.text());return;}
   if(url.pathname==='/admin') {res.setHeader('content-type','text/html');res.end(adminDocument('Dashboard',productOverviewPage({clients:[],runners:[]}),'dashboard'));return;}
   if(url.pathname==='/admin/central') {res.setHeader('set-cookie',ADMIN_CSRF_COOKIE+'=fixture-csrf; Path=/; SameSite=Strict; Secure');res.setHeader('content-type','text/html');res.end(adminDocument('Services & Skills',centralPage('fixture-csrf',true,true),'central'));return;}
   const raw=[];for await(const part of req)raw.push(part);
   const body=raw.length?JSON.parse(Buffer.concat(raw).toString()):undefined;
   requests.push({path:url.pathname,method:req.method,body});
   let value, code=200;const path=url.pathname.replace('/admin/central/',''),[kind,id]=path.split('/');
   if(kind==='profiles'&&!id){value={state:'listed',profiles,next_after:null};if(failLibrary){code=503;value={state:'unavailable'};}}
   else if(kind==='profiles'){
    if(body.action==='connect'){const p={profile_id:id,connector_id:body.connector_id,display_name:body.display_name,endpoint:body.endpoint,revision:1,enabled:false,credential:null,authentication:body.authentication};profiles.push(p);value={state:'written',profile:p};}
    else{const p=profiles.find(p=>p.profile_id===id);assert.equal(body.expected_revision,p.revision);p.revision++;if(body.action==='enable'||body.action==='disable')p.enabled=body.action==='enable';value={state:'written',profile:p};}
   }else if(kind==='connections'||kind==='oauth'){
    assert.equal(req.headers['x-csrf-token'],'fixture-csrf');
    if(id==='begin')value={state:'started',profile_id:body.profile_id,authorization_url:'/oauth-fixture'};
    else if(id==='complete'){if(body.error){assert.deepEqual(body,{state:'cancel-state',error:'access_denied'});code=503;value={error:{code:'oauth_reauthorization_required'}};}else{assert.deepEqual(body,{state:'fixture-state',iss:'https://login.provider.com',code:'fixture-code'});value={state:'linked',profile_id:profiles.at(-1).profile_id};}}
    else value={state:'revoked',profile_id:body.profile_id};
   }else if(kind==='skill-installations'){
    const item=library.find(s=>s.head.skill_id==='research');
    if((item?.head.revision??0)!==body.expected_revision){code=409;value={state:'conflict',skill_id:'research',current_revision:item.head.revision};}
    else{const entry={head:{skill_id:'research',revision:body.expected_revision+1,enabled:true,staged_digest:digest,active_digest:digest},bundle:{skill_id:'research',name:'research',description:'Research fixture',source:'Control panel upload',license:'',files:body.files,digest}};if(item)library.splice(library.indexOf(item),1,entry);else library.push(entry);value={state:'installed',skill_id:'research',name:'research',revision:entry.head.revision,digest};}
   }else if(kind==='discovery'){
    assert.equal(body.expected_revision,0);
    if(rejectDiscovery){code=503;value={error:{code:'remote_authorization_required',operation_state:'not_started'}};}
    else{
    const head={revision:1,observed_digest:digest,approved_digest:null,approved_names:[]};
    const snapshot={digest,tools:[{tool_id:'tool-search',public_name:'search',version:toolVersion,definition:{name:'search',description:'<img src=x onerror=alert(1)>',inputSchema:{type:'object',properties:{query:{type:'string'}}},annotations:{readOnlyHint:true}}}]};
    catalogs.set(id,{state:'found',head,snapshot,changes:[{name:'search',state:'added'}]});value={state:'written',head};}
   }else if(kind==='catalogs'){
    value=catalogs.get(id);if(!value){code=404;value={state:'missing'};}
    else if(body&&conflict){code=409;value={state:'conflict',current_revision:value.head.revision+1};}
    else if(body){assert.equal(body.expected_revision,value.head.revision);assert.equal(body.digest,digest);value.head={...value.head,revision:value.head.revision+1,approved_digest:digest,approved_names:body.tool_names};value.approved=structuredClone(value.snapshot);value={state:'written',head:value.head};}
    else if(url.searchParams.get('snapshot')===value.approved?.digest){value={...value,snapshot:value.approved};}
   }else if(kind==='skills'&&!id)value={state:'listed',skills:library.map(s=>({head:s.head,summary:{name:s.bundle.name,description:s.bundle.description}})),next_after:null};
   else if(kind==='skills'){
    const item=library.find(s=>s.head.skill_id===id);
    if(!body){if(item)value={state:'found',head:item.head,bundle:url.searchParams.get('digest')===item.published?.digest?item.published:item.bundle};else{code=404;value={state:'missing'};}}
    else if(body.action==='preview')value={state:'previewed',bundle:{skill_id:id,name:'research',description:'Research fixture',source:body.source,license:body.license,files:body.files,digest}};
    else if(body.action==='stage'){assert.equal(body.expected_revision,0);const entry={head:{skill_id:id,revision:1,enabled:false,staged_digest:digest,active_digest:null},bundle:{skill_id:id,name:'research',description:'Research fixture',source:body.source,license:body.license,files:body.files,digest}};library.push(entry);value={state:'written',head:entry.head};}
    else{assert.equal(body.expected_revision,item.head.revision);assert.equal(body.digest,digest);item.head={...item.head,revision:item.head.revision+1,enabled:true,active_digest:digest};value={state:'written',head:item.head};}
   }else if(kind==='grants'||kind==='toolsets'){throw new Error('Retired client access API must not be called');
   }else{code=404;value={state:'missing'};}
   res.statusCode=code;res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify(value));
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:{code:'fixture_failed'}}));exceptions.push(String(error));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const skillFolder=await mkdtemp(join(tmpdir(),'runmesh-product-skill-'));
 let browser;
 try{
  browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});
  const context=await browser.newContext({viewport:{width:1365,height:1000}});
  const page=await context.newPage();page.on('pageerror',e=>exceptions.push(e.message));
  await page.goto(origin+'/admin');
  assert.equal(await page.getByRole('heading',{name:'Make your AI client more useful'}).count(),1);
  assert.equal(await page.locator('h1').count(),1);
  assert.equal(await page.locator('details').getAttribute('open'),null);
  assert.equal(await page.getByText('Active shell jobs',{exact:true}).count(),0);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.setViewportSize({width:1365,height:1000});
  await page.getByRole('link',{name:'Explore services and Skills'}).click();
  await page.locator('[data-product-status]').filter({hasText:'Library is up to date.'}).waitFor();
  await page.goto(origin+'/admin/central?setup=missing');
  const status=page.locator('[data-product-status]');await status.filter({hasText:'Library is up to date.'}).waitFor();
  assert.equal(await page.locator('[data-service-create] button').isEnabled(),true);
  assert.equal(await page.locator('[data-central-tab=skills]').isEnabled(),true);
  assert.equal(await page.locator('[data-service-create] [name=endpoint]').getAttribute('type'),'url');
  await page.goto(origin+'/admin/central');await status.filter({hasText:'Library is up to date.'}).waitFor();
  assert.equal(await page.locator('.central-advanced,[data-central-admin]').count(),0);
  const form=page.locator('[data-service-create]');await form.locator('[name=name]').fill('团队文档');await form.locator('[name=endpoint]').fill('https://docs.example.com/mcp');await form.locator('button').click();
  await status.filter({hasText:'Review the tools before approving.'}).waitFor();
  assert.deepEqual(await form.locator('[name=authentication] option').evaluateAll(nodes=>nodes.map(n=>n.value)),['none','oauth']);assert.equal(await form.locator('[name=token]').count(),0);
  assert.equal(profiles[0].display_name,'团队文档');
  const review=page.locator('[data-service-review]');assert.equal(await review.locator('img').count(),0);
  assert.equal(await review.locator('input[type=checkbox]').isChecked(),false);
  assert.equal(requests.filter(r=>r.path.includes('/catalogs/')&&r.method==='POST').length,0);
  await review.locator('input[type=checkbox]').check();await review.getByRole('button',{name:'Approve selected tools'}).click();await status.filter({hasText:'Tools approved.'}).waitFor();
  rejectDiscovery=true;await form.locator('[name=endpoint]').fill('https://oauth.provider.com/mcp');await form.locator('[name=authentication]').selectOption('oauth');await form.locator('button').click();
  await status.filter({hasText:'Sign in to this service again using Reconnect.'}).waitFor();
  assert.equal(catalogs.has(profiles.at(-1).profile_id),false);assert.equal(await review.isHidden(),true);
  await page.getByRole('button',{name:'Reconnect',exact:true}).click();await status.filter({hasText:'Refresh the library before making another change.'}).waitFor();
  assert.equal(requests.filter(r=>r.path==='/admin/central/connections/begin').length,1);
  await page.locator('[data-product-refresh]').click();await status.filter({hasText:'Library is up to date.'}).waitFor();
  rejectDiscovery=false;await page.getByRole('button',{name:'Reconnect',exact:true}).click();
  await page.waitForURL(url=>url.pathname==='/admin/central'&&url.searchParams.has('connected'),{timeout:10000});await status.filter({hasText:'Review the tools before approving.'}).waitFor();
  assert.equal(requests.filter(r=>r.path==='/admin/central/connections/begin').length,2);assert.equal(requests.filter(r=>r.path==='/admin/central/connections/complete').length,2);assert.equal(new URL(page.url()).search,'');
  await page.locator('[data-central-tab=skills]').click();
  const importer=page.locator('[data-skill-import]');
  const folderText=['---','name: research','description: Research fixture','---','Selected folder version'].join(String.fromCharCode(10));
  await writeFile(join(skillFolder,'SKILL.md'),folderText);
  await importer.locator('[name=folder]').setInputFiles(skillFolder);
  await importer.locator('[name=files]').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from('---\nname: research\ndescription: Research fixture\n---\nReview this text.\n')});
  assert.equal(await importer.locator('[name=source],[name=license]').count(),0);await importer.getByRole('button',{name:'Install Skill',exact:true}).click();
  await status.filter({hasText:'installed. Ready to use'}).waitFor();assert.equal(library[0].head.enabled,true);
  assert.ok(library[0].bundle.files[0].text.includes('Review this text.'));assert.equal(await importer.locator('[name=folder]').evaluate(input=>input.files.length),0);
  await importer.locator('[name=files]').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from(['---','name: research','description: Research fixture','---','Updated text'].join(String.fromCharCode(10)))});await importer.getByRole('button',{name:'Install Skill',exact:true}).click();
  await status.filter({hasText:'This Skill is already installed.'}).waitFor();assert.equal(library[0].head.revision,1);
  const skillReview=page.locator('[data-skill-review]');await skillReview.getByRole('button',{name:'Cancel',exact:true}).click();
  await importer.getByRole('button',{name:'Install Skill',exact:true}).click();await status.filter({hasText:'This Skill is already installed.'}).waitFor();
  // Replacing the selection invalidates the old confirmation and its captured files.
  async function checkSelectionChange(select){
   const before=requests.filter(r=>r.path==='/admin/central/skill-installations').length;await select();
   const staleConfirmation=skillReview.getByRole('button',{name:'Update Skill',exact:true});
   if(await staleConfirmation.isVisible()){await staleConfirmation.click();await status.filter({hasText:'installed. Ready to use'}).waitFor();}
   assert.equal(library[0].head.revision,1,'Changing the selection must not allow the previous files to be installed');
   assert.equal(requests.filter(r=>r.path==='/admin/central/skill-installations').length,before);assert.equal(await skillReview.isHidden(),true);
  }
  await checkSelectionChange(()=>importer.locator('[name=folder]').setInputFiles(skillFolder));assert.equal(await importer.locator('[name=files]').evaluate(input=>input.files.length),0);
  await importer.getByRole('button',{name:'Install Skill',exact:true}).click();await status.filter({hasText:'This Skill is already installed.'}).waitFor();
  await checkSelectionChange(()=>importer.locator('[name=files]').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from(folderText.replace('Selected folder version','Selected file version'))}));
  await importer.getByRole('button',{name:'Install Skill',exact:true}).click();await status.filter({hasText:'This Skill is already installed.'}).waitFor();
  await checkSelectionChange(()=>importer.locator('[name=files]').setInputFiles([]));
  await importer.locator('[name=folder]').setInputFiles(skillFolder);
  await importer.getByRole('button',{name:'Install Skill',exact:true}).click();await status.filter({hasText:'This Skill is already installed.'}).waitFor();
  await skillReview.getByRole('button',{name:'Update Skill',exact:true}).click();await status.filter({hasText:'installed. Ready to use'}).waitFor();assert.equal(library[0].head.revision,2);assert.equal(library[0].bundle.files[0].text,folderText);
  // Publication conflict cannot trigger automatic replay, even after repeated clicks.
  await page.locator('[data-central-tab=services]').click();
  await page.locator('[data-service-list]').getByRole('button',{name:'Review tools',exact:true}).first().click();await status.filter({hasText:'Review the tools before approving.'}).waitFor();
  conflict=true;await review.getByRole('button',{name:'Approve selected tools'}).click();await status.filter({hasText:'This item changed.'}).waitFor();
  const writes=requests.filter(r=>r.method==='POST').length;await review.getByRole('button',{name:'Approve selected tools'}).click();await status.filter({hasText:'Refresh the library before'}).waitFor();assert.equal(requests.filter(r=>r.method==='POST').length,writes);
  conflict=false;await page.locator('[data-product-refresh]').click();await status.filter({hasText:'Library is up to date.'}).waitFor();assert.equal(await review.isHidden(),true);
  await page.goto(origin+'/admin/central?client=client-fixture');await status.filter({hasText:'Library is up to date.'}).waitFor();
  assert.equal(await page.locator('[data-central-tab=access],[data-client-select],[data-client-access]').count(),0);
  assert.equal(requests.filter(r=>/\/(grants|toolsets)\//.test(r.path)).length,0);
  failLibrary=true;await page.locator('[data-product-refresh]').click();await status.filter({hasText:'Operation could not be confirmed.'}).waitFor();
  const mutations=requests.filter(r=>r.method==='POST').length;await page.locator('[data-service-list]').getByRole('button',{name:'Pause',exact:true}).first().click();await status.filter({hasText:'Refresh the library before'}).waitFor();assert.equal(requests.filter(r=>r.method==='POST').length,mutations);
  failLibrary=false;await page.locator('[data-product-refresh]').click();await status.filter({hasText:'Library is up to date.'}).waitFor();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  const callback=await page.context().newPage();callback.on('pageerror',e=>exceptions.push(e.message));
  await callback.goto(origin+'/admin/central/oauth/callback?state=fixture-state&code=fixture-code&iss=https://login.provider.com&scope=read');
  await callback.getByText('Authorization completed.',{exact:false}).waitFor();assert.equal(new URL(callback.url()).search,'');
  for(const route of ['connections','oauth']){
   const path='/admin/central/'+route;
   await callback.goto(origin+path+'/callback?state=cancel-state&error=access_denied&error_description=PRIVATE_PROVIDER_DETAIL&error_uri=https://provider.com/error');
   await callback.getByText('Authorization was not confirmed.',{exact:false}).waitFor();assert.equal(new URL(callback.url()).search,'');assert.equal((await callback.content()).includes('PRIVATE_PROVIDER_DETAIL'),false);
   const callbacks=requests.filter(r=>r.path===path+'/complete').length;
   for(const duplicate of ['state=one&state=two&code=unused','state=one&code=unused&code=again','state=one&code=unused&iss=one&iss=two','state=one&error=access_denied&error=again']){
    await callback.goto(origin+path+'/callback?'+duplicate);await callback.getByText('Authorization not completed.',{exact:false}).waitFor();assert.equal(new URL(callback.url()).search,'');
   }
   assert.equal(requests.filter(r=>r.path===path+'/complete').length,callbacks);
  }
  await callback.close();
  assert.deepEqual(exceptions,[]);
  return {state:'passed',guided_homepage:true,direct_url_without_deployment_setup:true,service_explicit_review:true,oauth_return_to_tool_review:true,oauth_extra_parameters_ignored:true,oauth_duplicate_parameters_rejected:true,oauth_provider_errors_not_reflected:true,direct_skill_install_and_confirmed_update:true,skill_file_folder_selection_switch:true,skill_selection_invalidates_confirmation:true,shared_library_without_client_assignment:true,retired_access_api_not_called:true,failed_refresh_blocks_writes:true,conflict_no_replay:true,mobile_no_overflow:true,screenshots:0};
 }finally{await browser?.close();await new Promise(r=>server.close(r));await rm(join(skillFolder,'SKILL.md'),{force:true});await rmdir(skillFolder);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 console.log(JSON.stringify(await checkGuidedProduct(process.env.RUNMESH_CHROMIUM_EXECUTABLE)));
}
