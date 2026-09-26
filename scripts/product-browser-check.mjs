import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { adminDocument } from '../apps/worker/dist/admin/layout.js';
import { centralPage } from '../apps/worker/dist/admin/central-view.js';
import { productOverviewPage } from '../apps/worker/dist/admin/dashboard-views.js';

/** Isolated browser fixtures exercise the shipped UI, never a user browser or external service. */
export async function checkGuidedProduct(executable) {
 const digest='a'.repeat(64), oldDigest='b'.repeat(64), toolVersion='c'.repeat(64);
 const profiles=[], library=[], requests=[], exceptions=[];
 const pinned={kind:'skill',resource_id:'legacy-skill',version:oldDigest};
 let grant={client_id:'client-fixture',revision:1,enabled:true,rules:[pinned]}, conflict=false, failLibrary=false;
 const catalogs=new Map();
 const server=createServer(async(req,res)=>{
  try {
   const url=new URL(req.url,'http://127.0.0.1');
   if(url.pathname==='/admin') {res.setHeader('content-type','text/html');res.end(adminDocument('Dashboard',productOverviewPage({clients:[],runners:[]}),'dashboard'));return;}
   if(url.pathname==='/admin/central') {res.setHeader('content-type','text/html');res.end(adminDocument('Services & Skills',centralPage('fixture-csrf',true,true,false,[{id:'client-fixture',label:'Team AI'}],url.searchParams.get('setup')==='missing'?{endpoints:[],credentialsReady:false}:{endpoints:['https://docs.example/mcp'],credentialsReady:true}),'central'));return;}
   const raw=[];for await(const part of req)raw.push(part);
   const body=raw.length?JSON.parse(Buffer.concat(raw).toString()):undefined;
   requests.push({path:url.pathname,method:req.method,body});
   let value, code=200;const path=url.pathname.replace('/admin/central/',''),[kind,id]=path.split('/');
   if(kind==='profiles'&&!id){value={state:'listed',profiles,next_after:null};if(failLibrary){code=503;value={state:'unavailable'};}}
   else if(kind==='profiles'){
    if(body.action==='create'){const p={profile_id:id,connector_id:body.connector_id,display_name:body.display_name,endpoint:body.endpoint,revision:1,enabled:false};profiles.push(p);value={state:'written',profile:p};}
    else{const p=profiles.find(p=>p.profile_id===id);assert.equal(body.expected_revision,p.revision);p.revision++;if(body.action==='enable'||body.action==='disable')p.enabled=body.action==='enable';value={state:'written',profile:p};}
   }else if(kind==='discovery'){
    assert.equal(body.expected_revision,0);
    const head={revision:1,observed_digest:digest,approved_digest:null,approved_names:[]};
    const snapshot={digest,tools:[{tool_id:'tool-search',public_name:'search',version:toolVersion,definition:{name:'search',description:'<img src=x onerror=alert(1)>',inputSchema:{type:'object',properties:{query:{type:'string'}}},annotations:{readOnlyHint:true}}}]};
    catalogs.set(id,{state:'found',head,snapshot,changes:[{name:'search',state:'added'}]});value={state:'written',head};
   }else if(kind==='catalogs'){
    value=catalogs.get(id);if(!value){code=404;value={state:'missing'};}
    else if(body){assert.equal(body.expected_revision,value.head.revision);assert.equal(body.digest,digest);value.head={...value.head,revision:value.head.revision+1,approved_digest:digest,approved_names:body.tool_names};value={state:'written',head:value.head};}
   }else if(kind==='skills'&&!id)value={state:'listed',skills:library.map(s=>({head:s.head,summary:{name:s.bundle.name,description:s.bundle.description}})),next_after:null};
   else if(kind==='skills'){
    const item=library.find(s=>s.head.skill_id===id);
    if(!body){if(item)value={state:'found',head:item.head,bundle:url.searchParams.get('digest')===item.published?.digest?item.published:item.bundle};else{code=404;value={state:'missing'};}}
    else if(body.action==='preview')value={state:'previewed',bundle:{skill_id:id,name:'research',description:'Research fixture',source:body.source,license:body.license,files:body.files,digest}};
    else if(body.action==='stage'){assert.equal(body.expected_revision,0);const entry={head:{skill_id:id,revision:1,enabled:false,staged_digest:digest,active_digest:null},bundle:{skill_id:id,name:'research',description:'Research fixture',source:body.source,license:body.license,files:body.files,digest}};library.push(entry);value={state:'written',head:entry.head};}
    else{assert.equal(body.expected_revision,item.head.revision);assert.equal(body.digest,digest);item.head={...item.head,revision:item.head.revision+1,enabled:true,active_digest:digest};value={state:'written',head:item.head};}
   }else if(kind==='grants'){
    if(body&&conflict){code=409;value={state:'conflict',current_revision:grant.revision+1};}
    else{if(body){assert.equal(body.expected_revision,grant.revision);grant={...grant,...body,revision:grant.revision+1};}value={state:body?'written':'found',grant};}
   }else{code=404;value={state:'missing'};}
   res.statusCode=code;res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify(value));
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:{code:'fixture_failed'}}));exceptions.push(String(error));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 let browser;
 try{
  browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});
  const page=await browser.newPage({viewport:{width:1365,height:1000}});page.on('pageerror',e=>exceptions.push(e.message));
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
  assert.equal(await page.locator('[data-service-create] button').isDisabled(),true);
  assert.equal(await page.locator('[data-central-tab=skills]').isEnabled(),true);
  assert.equal(await page.getByRole('heading',{name:'Service connections need instance setup'}).count(),1);
  await page.goto(origin+'/admin/central');await status.filter({hasText:'Library is up to date.'}).waitFor();
  assert.equal(await page.locator('.central-advanced').getAttribute('open'),null);
  const form=page.locator('[data-service-create]');await form.locator('[name=name]').fill('团队文档');await form.locator('[name=endpoint]').selectOption('https://docs.example/mcp');await form.locator('[name=token]').fill('synthetic-fixture-token');await form.locator('button').click();
  await status.filter({hasText:'Review the tools before approving.'}).waitFor();
  assert.equal(await form.locator('[name=token]').inputValue(),'');
  assert.equal(profiles[0].display_name,'团队文档');
  const review=page.locator('[data-service-review]');assert.equal(await review.locator('img').count(),0);
  assert.equal(await review.locator('input[type=checkbox]').isChecked(),false);
  assert.equal(requests.filter(r=>r.path.includes('/catalogs/')&&r.method==='POST').length,0);
  await review.locator('input[type=checkbox]').check();await review.getByRole('button',{name:'Approve selected tools'}).click();await status.filter({hasText:'Tools approved.'}).waitFor();
  await page.getByText('Update service credentials',{exact:true}).click();
  const rotate=page.locator('[data-service-list] form');await rotate.locator('input').fill('synthetic-replacement-token');await rotate.getByRole('button').click();await status.filter({hasText:'Access token updated.'}).waitFor();
  assert.equal(await page.locator('[data-service-list] input').inputValue(),'');
  assert.equal(requests.filter(r=>r.body?.action==='rotate').length,1);assert.equal(profiles[0].enabled,true);
  await page.locator('[data-central-tab=skills]').click();
  const importer=page.locator('[data-skill-import]');
  await importer.locator('[name=files]').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from('---\nname: research\ndescription: Research fixture\n---\nReview this text.\n')});
  await importer.locator('[name=source]').fill('Local fixture');await importer.locator('[name=license]').fill('MIT');await importer.getByRole('button',{name:'Preview Skill'}).click();
  await status.filter({hasText:'Preview ready.'}).waitFor();assert.equal(library.length,0);
  const skillReview=page.locator('[data-skill-review]');await skillReview.getByRole('button').click();await status.filter({hasText:'approval box first'}).waitFor();assert.equal(library.length,0);
  await skillReview.locator('input[type=checkbox]').check();await skillReview.getByRole('button').click();await status.filter({hasText:'Skill published.'}).waitFor();assert.equal(library[0].head.enabled,true);
  // A staged draft must never describe the older version being granted.
  library[0].published=library[0].bundle;library[0].bundle={...library[0].bundle,name:'unreviewed-draft',description:'Unapproved description',digest:oldDigest};library[0].head.staged_digest=oldDigest;library[0].head.revision++;
  await page.locator('[data-product-refresh]').click();await status.filter({hasText:'Library is up to date.'}).waitFor();
  await page.locator('[data-central-tab=access]').click();await page.locator('[data-client-select]').selectOption('client-fixture');await status.filter({hasText:'Review the selected client'}).waitFor();
  const access=page.locator('[data-client-access]');await access.getByText('research (Skill)',{exact:true}).click();await access.getByText('团队文档 / search',{exact:true}).click();await access.getByRole('button').click();await status.filter({hasText:'Access saved.'}).waitFor();
  assert.equal(await access.getByText('unreviewed-draft (Skill)',{exact:true}).count(),0);
  assert.equal(grant.rules.length,3);assert.ok(grant.rules.some(r=>r.resource_id==='legacy-skill'&&r.version===oldDigest));
  conflict=true;await access.getByRole('button').click();await status.filter({hasText:'This item changed.'}).waitFor();const writes=requests.filter(r=>r.path.includes('/grants/')&&r.method==='POST').length;
  await access.getByRole('button').click();await status.filter({hasText:'Refresh the library before'}).waitFor();assert.equal(requests.filter(r=>r.path.includes('/grants/')&&r.method==='POST').length,writes);
  conflict=false;await page.locator('[data-product-refresh]').click();await status.filter({hasText:'Library is up to date.'}).waitFor();
  assert.equal(await page.locator('[data-client-select]').inputValue(),'client-fixture');
  await page.goto(origin+'/admin/central?client=client-fixture');await status.filter({hasText:'Review the selected client'}).waitFor();
  assert.equal(await access.isVisible(),true);assert.equal(await page.locator('[data-client-select]').inputValue(),'client-fixture');
  await page.locator('[data-central-tab=services]').click();
  failLibrary=true;await page.locator('[data-product-refresh]').click();await status.filter({hasText:'Operation could not be confirmed.'}).waitFor();
  const mutations=requests.filter(r=>r.method==='POST').length;await page.locator('[data-service-list]').getByRole('button',{name:'Pause',exact:true}).click();await status.filter({hasText:'Refresh the library before'}).waitFor();assert.equal(requests.filter(r=>r.method==='POST').length,mutations);
  failLibrary=false;await page.locator('[data-product-refresh]').click();await status.filter({hasText:'Library is up to date.'}).waitFor();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(exceptions,[]);
  return {state:'passed',guided_homepage:true,setup_blocks_unavailable_connections:true,service_explicit_review:true,credential_rotation:true,skill_preview_before_publish:true,published_skill_metadata:true,retained_pinned_access:true,client_handoff:true,failed_refresh_blocks_writes:true,conflict_no_replay:true,mobile_no_overflow:true,screenshots:0};
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 console.log(JSON.stringify(await checkGuidedProduct(process.env.RUNMESH_CHROMIUM_EXECUTABLE)));
}
