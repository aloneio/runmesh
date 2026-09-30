import { createProductFixture } from './product-browser-fixture.mjs';
import { skillInstallation } from '../apps/worker/dist/domain/skills/install.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { checkRunnerActions } from './runner-browser-check.mjs';
import { checkAdminNavigation } from './navigation-browser-check.mjs';
import { checkAdminLayout } from './layout-browser-check.mjs';
import { checkSkillUploads } from './skill-upload-browser-check.mjs';

async function checkClientPermissions(browser, origin, errors) {
 for(const locale of ['en','zh-CN']) {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  page.on('pageerror',error=>errors.push(error.message));
  try {
   await page.goto(origin+'/admin/clients?lang='+locale);
   const form=page.locator('#add-client form'), mode=form.locator('[name=access_mode]');
   const permissions=form.locator('[data-client-computer-permissions]');
   const read=form.locator('[value="coding:read"]'), write=form.locator('[value="coding:write"]'), exec=form.locator('[value="coding:exec"]');
   assert.equal(await permissions.locator('summary').textContent(),locale==='en'?'Computer permissions':'计算机权限');
   assert.equal(await permissions.evaluate(node=>node.open),false);
   await mode.selectOption('native');
   assert.equal(await permissions.evaluate(node=>node.open),true);
   assert.equal(await read.isVisible(),true);
   assert.equal(await read.isChecked(),true);
   assert.equal(await write.isChecked(),false);
   assert.equal(await exec.isChecked(),false);
   await write.check(); await read.uncheck();
   await mode.selectOption('central');
   assert.equal(await permissions.evaluate(node=>node.open),false);
   await mode.selectOption('native');
   assert.equal(await permissions.evaluate(node=>node.open),true);
   assert.equal(await read.isChecked(),false);
   assert.equal(await write.isChecked(),true);
   assert.equal(await exec.isChecked(),false);
   assert.deepEqual(await form.evaluate(node=>new FormData(node).getAll('scopes')),['coding:write']);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await permissions.locator('summary').click();
   assert.equal(await permissions.evaluate(node=>node.open),false);
   await page.evaluate(()=>{window.clientPermissionsNavigationMarker=true;});
   await page.locator('nav a[href="/admin/central"]').click();
   await page.locator('[data-central-product][aria-busy="false"]').waitFor();
   await page.locator('nav a[href="/admin/clients"]').click();
   await mode.waitFor();
   assert.equal(await page.evaluate(()=>window.clientPermissionsNavigationMarker),true,'Client permissions must bind after in-page navigation');
   assert.equal(await permissions.evaluate(node=>node.open),false);
   await mode.selectOption('native');
   assert.equal(await read.isVisible(),true);
   assert.equal(await permissions.evaluate(node=>node.open),true);
   await page.goto(origin+'/admin/clients?native-only=1&lang='+locale);
   assert.equal(await mode.inputValue(),'native');
   assert.equal(await permissions.evaluate(node=>node.open),true);
   assert.equal(await read.isVisible(),true);
  } finally { await page.close(); }
 }
}

async function checkSkillFileErrors(browser, origin, requests, library) {
 for(const locale of ['en','zh-CN'])for(const failure of ['encoding','reading']){
  const page=await browser.newPage();
  try{
   if(failure==='reading')await page.addInitScript(()=>{
    const read=File.prototype.arrayBuffer;let fail=true;
    File.prototype.arrayBuffer=function(){if(fail){fail=false;return Promise.reject(new DOMException('PRIVATE_FILE_READ_DETAIL','NotReadableError'));}return read.call(this);};
   });
   await page.goto(origin+'/admin/central?lang='+locale);
   await page.locator('[data-central-product][aria-busy="false"]').waitFor();
   await page.locator('[data-central-tab=skills]').click();
   const form=page.locator('[data-skill-import]'),status=page.locator('[data-product-status]');
   const name='file-recovery-'+failure,content='---\nname: '+name+'\ndescription: 文件读取测试\n---\nKeep this text unchanged.\n';
   const writes=requests.filter(request=>request.path==='/admin/central/skill-installations').length;
   await form.locator('[name=files]').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:failure==='encoding'?Buffer.from([0xff]):Buffer.from(content)});
   await form.locator('[type=submit]').click();
   await page.locator('[data-central-product][aria-busy="false"]').waitFor();
   assert.equal(await status.textContent(),locale==='en'?'Could not read the selected files. Select UTF-8 text files and try again.':'无法读取所选文件，请选择 UTF-8 文本文件后重试。');
   assert.equal(await status.getAttribute('data-error'),'true');
   assert.equal(requests.filter(request=>request.path==='/admin/central/skill-installations').length,writes);
   await form.locator('[name=files]').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from(content)});
   await form.locator('[type=submit]').click();
   await status.filter({hasText:name+(locale==='en'?' installed.':' 已安装。')}).waitFor();
   const installs=requests.filter(request=>request.path==='/admin/central/skill-installations');
   assert.equal(installs.length,writes+1);
   assert.equal(installs.at(-1).body.files[0].text,content);
  }finally{await page.close();library.length=0;}
 }
}

/** Isolated browser fixtures exercise the shipped UI, never a user browser or external service. */
export async function checkGuidedProduct(executable) {
 await checkAdminLayout(executable);
 await checkAdminNavigation(executable);
 await checkRunnerActions(executable);
 const fixture = await createProductFixture();
 const { digest, toolVersion, profiles, library, requests, exceptions, catalogs, controls, origin } = fixture;
 const skillFolder=await mkdtemp(join(tmpdir(),'runmesh-product-skill-'));
 let browser;
 try{
  browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{})});
  await checkClientPermissions(browser,origin,exceptions);
  await checkSkillFileErrors(browser,origin,requests,library);
  await checkSkillUploads(browser,origin,requests,library);
  const context=await browser.newContext({viewport:{width:1365,height:1000}});
  const page=await context.newPage();page.on('pageerror',e=>exceptions.push(e.message));
  await page.goto(origin+'/admin');
  assert.equal(await page.getByRole('heading',{name:'Use your tools across AI clients'}).count(),1);
  assert.equal(await page.locator('h1').count(),1);
  assert.equal(await page.locator('details').getAttribute('open'),null);
  assert.equal(await page.getByText('Active shell jobs',{exact:true}).count(),0);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.setViewportSize({width:1365,height:1000});
  await page.getByRole('link',{name:'Explore MCPs and Skills'}).click();
  await page.locator('[data-product-status]').filter({hasText:'List refreshed.'}).waitFor();
  await page.goto(origin+'/admin/central?setup=missing');
  const status=page.locator('[data-product-status]');await status.filter({hasText:'List refreshed.'}).waitFor();
  assert.equal(await page.locator('[data-service-create] button').isEnabled(),true);
  assert.equal(await page.locator('[data-central-tab=skills]').isEnabled(),true);
  assert.equal(await page.locator('[data-service-create] [name=endpoint]').getAttribute('type'),'url');
  await page.goto(origin+'/admin/central');await status.filter({hasText:'List refreshed.'}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'MCP & Skill',exact:true}).count(),1);
  assert.equal(await page.locator('[data-central-tab=services]').textContent(),'MCP');
  assert.equal(await page.locator('[data-central-tab=skills]').textContent(),'Skill');
  assert.equal(await page.locator('.central-start').count(),0);
  assert.equal(await page.getByText('All connected AI clients share enabled MCPs and Skills. Pause an item to stop sharing it.',{exact:true}).count(),0);
  assert.equal(await page.locator('.central-advanced,[data-central-admin]').count(),0);
  const form=page.locator('[data-service-create]');
  await form.locator('[name=endpoint]').fill('http://docs.example.com/mcp');await form.locator('button').click();
  await status.filter({hasText:'Check the MCP name and enter a public HTTPS MCP URL.'}).waitFor();
  assert.equal(profiles.length,0);assert.equal((await status.textContent()).includes('SKILL.md'),false);
  assert.equal(await form.locator('[name=endpoint]').inputValue(),'http://docs.example.com/mcp');
  // Correcting a confirmed rejected input needs no unrelated library refresh.
  await form.locator('[name=name]').fill('团队文档');await form.locator('[name=endpoint]').fill('https://docs.example.com/mcp');await form.locator('button').click();
  await status.filter({hasText:'Connected.'}).waitFor();
  assert.deepEqual(await form.locator('[name=authentication] option').evaluateAll(nodes=>nodes.map(n=>n.value)),['none','oauth']);assert.equal(await form.locator('[name=token]').count(),0);
  assert.equal(profiles[0].display_name,'团队文档');
  const review=page.locator('[data-service-tools]');assert.equal(await review.locator('img').count(),0);
  assert.equal(await review.locator('h2').textContent(),'团队文档');
  assert.equal(await review.locator('.section-title span').textContent(),'1 tool');
  assert.equal(await review.locator('article').count(),1);
  assert.equal(await review.locator('article h3').textContent(),'search');
  assert.equal(await review.locator('article h3').evaluate(node=>getComputedStyle(node).textTransform),'none');
  assert.equal(await review.locator('article p').textContent(),'<img src=x onerror=alert(1)>');
  assert.equal(await review.locator('details,pre').count(),0);
  assert.equal(await review.getByText('Tools from enabled services are available to all connected AI clients automatically.',{exact:true}).count(),0);
  assert.equal(await review.locator('input[type=checkbox]').count(),0);
  assert.deepEqual(catalogs.get(profiles[0].profile_id).head.approved_names,['search']);
  assert.equal(await review.getByRole('button').count(),0);
  assert.equal(requests.filter(r=>r.path.includes('/catalogs/')&&r.method==='POST').length,0);
  // Existing connected catalogs, including an empty prior selection, finish automatically.
  for(const approved of [null,digest]){
   const existing=catalogs.get(profiles[0].profile_id);existing.head.approved_digest=approved;existing.head.approved_names=[];
   const before=requests.filter(r=>r.path.startsWith('/admin/central/discovery/')).length;
   const catalogPath='/admin/central/catalogs/'+profiles[0].profile_id;
   const reads=requests.filter(r=>r.path===catalogPath&&r.method==='GET').length;
   await page.reload();await status.filter({hasText:'Connected.'}).waitFor();
   assert.deepEqual(catalogs.get(profiles[0].profile_id).head.approved_names,['search']);
   assert.equal(requests.filter(r=>r.path.startsWith('/admin/central/discovery/')).length,before+1);
   assert.equal(requests.filter(r=>r.path===catalogPath&&r.method==='GET').length,reads+2,'Recovery reads the catalog once before discovery and once after publication');
  }
  controls.discovery.reject=true;await form.locator('[name=endpoint]').fill('https://oauth.provider.com/mcp');await form.locator('[name=authentication]').selectOption('oauth');await form.locator('button').click();
  await status.filter({hasText:'Select Reconnect to sign in to this MCP again.'}).waitFor();
  assert.equal(catalogs.has(profiles.at(-1).profile_id),false);assert.equal(await review.isHidden(),true);
  // Reconnect refreshes state itself; failed reconciliation must still block the handoff.
  controls.library.unavailable=true;
  await page.getByRole('button',{name:'Reconnect',exact:true}).click();await status.filter({hasText:'Could not confirm the result. Refresh to check the status.'}).waitFor();
  assert.equal(requests.filter(r=>r.path==='/admin/central/connections/begin').length,1);
  controls.library.unavailable=false;controls.discovery.reject=false;
  // Observe the return before clicking: completion removes its query from history.
  await Promise.all([
   page.waitForURL(url=>url.pathname==='/admin/central'&&url.searchParams.has('connected'),{waitUntil:'commit',timeout:10000}),
   page.getByRole('button',{name:'Reconnect',exact:true}).click(),
  ]);
  await status.filter({hasText:'Connected.'}).waitFor();
  assert.equal(requests.filter(r=>r.path==='/admin/central/connections/begin').length,2);assert.equal(requests.filter(r=>r.path==='/admin/central/connections/complete').length,2);assert.equal(new URL(page.url()).search,'');
  // A completed OAuth sign-in whose return was interrupted also finishes on reopening.
  const oauthId=profiles.at(-1).profile_id;catalogs.delete(oauthId);
  await page.reload();await status.filter({hasText:'Connected.'}).waitFor();
  assert.deepEqual(catalogs.get(oauthId).head.approved_names,['search']);
  assert.equal(requests.filter(r=>r.path==='/admin/central/connections/begin').length,2);
  const oauthCard=page.locator('[data-service-list] .central-card').filter({has:page.getByRole('button',{name:'Reconnect',exact:true})});
  const discoveries=requests.filter(r=>r.path.startsWith('/admin/central/discovery/')).length;
  await oauthCard.getByRole('button',{name:'Pause',exact:true}).click();await status.filter({hasText:'List refreshed.'}).waitFor();
  assert.equal(await oauthCard.getByRole('button',{name:'Reconnect',exact:true}).isDisabled(),true);
  assert.equal(await oauthCard.getByRole('button',{name:'Refresh tools',exact:true}).isDisabled(),true);
  assert.equal(await oauthCard.getByRole('button',{name:'View tools',exact:true}).isEnabled(),true);
  assert.equal(await oauthCard.getByText('Enable this MCP to refresh tools or reconnect your account.',{exact:true}).isVisible(),true);
  assert.equal(await oauthCard.getByRole('button',{name:'Disconnect account',exact:true}).isEnabled(),true);
  assert.equal(requests.filter(r=>r.path==='/admin/central/connections/begin').length,2);
  await oauthCard.getByRole('button',{name:'Enable',exact:true}).click();await status.filter({hasText:'Connected.'}).waitFor();
  assert.equal(await oauthCard.getByRole('button',{name:'Reconnect',exact:true}).isEnabled(),true);
  assert.equal(await oauthCard.getByRole('button',{name:'Refresh tools',exact:true}).isEnabled(),true);
  assert.equal(await oauthCard.getByText('Enable this MCP to refresh tools or reconnect your account.',{exact:true}).count(),0);
  const publicCard=page.locator('[data-service-list] .central-card').filter({has:page.getByText('https://docs.example.com/mcp',{exact:true})});
  await publicCard.getByRole('button',{name:'Pause',exact:true}).click();await status.filter({hasText:'List refreshed.'}).waitFor();
  assert.equal(await publicCard.getByRole('button',{name:'Refresh tools',exact:true}).isDisabled(),true);
  assert.equal(await publicCard.getByRole('button',{name:'View tools',exact:true}).isEnabled(),true);
  assert.equal(await publicCard.getByText('Enable this MCP to refresh its tools.',{exact:true}).isVisible(),true);
  assert.equal(await publicCard.getByRole('button',{name:'Reconnect',exact:true}).count(),0);
  await publicCard.getByRole('button',{name:'Enable',exact:true}).click();await status.filter({hasText:'Connected.'}).waitFor();
  assert.equal(await publicCard.getByRole('button',{name:'Refresh tools',exact:true}).isEnabled(),true);
  assert.equal(await publicCard.getByText('Enable this MCP to refresh its tools.',{exact:true}).count(),0);
  assert.equal(requests.filter(r=>r.path.startsWith('/admin/central/discovery/')).length,discoveries+2);
  // Reauthorizing an earlier MCP must retain its identity after another is added.
  await form.locator('[name=name]').fill('Later public MCP');
  await form.locator('[name=endpoint]').fill('https://later.example.com/mcp');
  await form.locator('[name=authentication]').selectOption('none');
  await form.locator('button').click();await status.filter({hasText:'Connected.'}).waitFor();
  const reconnectStart=requests.length;
  let returnedProfile;
  await Promise.all([
   page.waitForURL(url=>{if(url.pathname!=='/admin/central'||!url.searchParams.has('connected'))return false;returnedProfile=url.searchParams.get('connected');return true;},{waitUntil:'commit',timeout:10000}),
   oauthCard.getByRole('button',{name:'Reconnect',exact:true}).click(),
  ]);
  assert.equal(returnedProfile,oauthId,'OAuth completion must belong to the MCP that started it');
  await status.filter({hasText:'Connected.'}).waitFor();await page.waitForLoadState('networkidle');
  const reconnectedFlow=requests.slice(reconnectStart);
  assert.equal(reconnectedFlow.find(r=>r.path==='/admin/central/connections/begin').body.profile_id,oauthId);
  assert.equal(reconnectedFlow.filter(r=>r.path==='/admin/central/discovery/'+oauthId).length,1);
  assert.equal(reconnectedFlow.filter(r=>r.path==='/admin/central/connections/complete').length,1);
  assert.equal(await review.locator('h2').textContent(),'oauth.provider.com');
  // User-triggered discovery continues directly to sign-in when OAuth is missing.
  for(const action of ['Refresh tools','Enable']){
   if(action==='Enable'){await oauthCard.getByRole('button',{name:'Pause',exact:true}).click();await status.filter({hasText:'List refreshed.'}).waitFor();}
   controls.discovery.reject=true;controls.oauth.authorizeDiscoveryOnComplete=true;
   const start=requests.length;
   await oauthCard.getByRole('button',{name:action,exact:true}).click();
   await status.filter({hasText:'Connected.'}).waitFor();await page.waitForLoadState('networkidle');
   const flow=requests.slice(start);
   assert.equal(flow.filter(r=>r.path==='/admin/central/connections/begin').length,1,'One click starts one OAuth handoff: '+action);
   assert.equal(flow.filter(r=>r.path==='/admin/central/connections/complete').length,1);
   assert.equal(flow.filter(r=>r.path==='/admin/central/discovery/'+oauthId).length,2,'Discover before authorization and publish after callback');
   assert.equal(flow.find(r=>r.path==='/admin/central/connections/begin').body.expected_revision,profiles.find(p=>p.profile_id===oauthId).revision);
  }
  // Failed authorization after a callback cannot redirect in a loop, even on reload.
  controls.discovery.reject=true;
  const noLoopStart=requests.length;
  await oauthCard.getByRole('button',{name:'Refresh tools',exact:true}).click();
  await status.filter({hasText:'Select Reconnect to sign in to this MCP again.'}).waitFor();await page.waitForLoadState('networkidle');
  assert.equal(requests.slice(noLoopStart).filter(r=>r.path==='/admin/central/connections/begin').length,1);
  catalogs.delete(oauthId);await page.reload();
  await status.filter({hasText:'Select Reconnect to sign in to this MCP again.'}).waitFor();await page.waitForLoadState('networkidle');
  assert.equal(requests.slice(noLoopStart).filter(r=>r.path==='/admin/central/connections/begin').length,1,'Background recovery does not restart authorization');
  // A public MCP and an uncertain failure must never silently initiate OAuth.
  for(const card of [publicCard,oauthCard]){
   controls.discovery.uncertainAuthorization=card===oauthCard;
   const start=requests.length;
   await card.getByRole('button',{name:'Refresh tools',exact:true}).click();
   await status.filter({hasText:'Select Reconnect to sign in to this MCP again.'}).waitFor();await page.waitForLoadState('networkidle');
   assert.equal(requests.slice(start).filter(r=>r.path==='/admin/central/connections/begin').length,0);
  }
  controls.discovery.uncertainAuthorization=false;controls.discovery.reject=false;
  await page.locator('[data-product-refresh]').click();await status.filter({hasText:'List refreshed.'}).waitFor();
  await oauthCard.getByRole('button',{name:'Refresh tools',exact:true}).click();await status.filter({hasText:'Connected.'}).waitFor();
  assert.equal(await page.locator('[data-service-list] input[type=password]').count(),0);
  assert.equal(await page.getByText('Update service credentials',{exact:true}).count(),0);
  await page.locator('[data-central-tab=skills]').click();
  const importer=page.locator('[data-skill-import]');
  const folderText=['---','name: research','description: Research fixture','---','Selected folder version'].join(String.fromCharCode(10));
  await writeFile(join(skillFolder,'SKILL.md'),folderText);
  await importer.locator('[name=folder]').setInputFiles(skillFolder);
  await importer.locator('[name=files]').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from('---\nname: research\ndescription: Research fixture\n---\nReview this text.\n')});
  assert.equal(await importer.locator('[name=source],[name=license]').count(),0);await importer.getByRole('button',{name:'Install Skill',exact:true}).click();
  await status.filter({hasText:'research installed.'}).waitFor();assert.equal(library[0].head.enabled,true);
  assert.ok(library[0].bundle.files[0].text.includes('Review this text.'));assert.equal(await importer.locator('[name=folder]').evaluate(input=>input.files.length),0);
  await importer.locator('[name=files]').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from(['---','name: research','description: Research fixture','---','Updated text'].join(String.fromCharCode(10)))});await importer.getByRole('button',{name:'Install Skill',exact:true}).click();
  await status.filter({hasText:'This Skill is already installed.'}).waitFor();assert.equal(library[0].head.revision,1);
  const skillReview=page.locator('[data-skill-review]');await skillReview.getByRole('button',{name:'Cancel',exact:true}).click();
  await importer.getByRole('button',{name:'Install Skill',exact:true}).click();await status.filter({hasText:'This Skill is already installed.'}).waitFor();
  // Replacing the selection invalidates the old confirmation and its captured files.
  async function checkSelectionChange(select){
   const before=requests.filter(r=>r.path==='/admin/central/skill-installations').length;await select();
   const staleConfirmation=skillReview.getByRole('button',{name:'Update Skill',exact:true});
   if(await staleConfirmation.isVisible()){await staleConfirmation.click();await status.filter({hasText:'research installed.'}).waitFor();}
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
  await skillReview.getByRole('button',{name:'Update Skill',exact:true}).click();await status.filter({hasText:'research installed.'}).waitFor();assert.equal(library[0].head.revision,2);assert.equal(library[0].bundle.files[0].text,folderText);
  // A staged update must remain separate from the active bundle until reviewed and published.
  const installedSkill=library[0], stagedDigest='b'.repeat(64), stagedText=folderText.replace('Selected folder version','Reviewed staged version');
  const skillWrites=()=>requests.filter(r=>r.path==='/admin/central/skills/research'&&r.method==='POST').length;
  const beforeReview=skillWrites();installedSkill.published=structuredClone(installedSkill.bundle);
  installedSkill.bundle={...installedSkill.bundle,digest:stagedDigest,files:[{path:'SKILL.md',text:stagedText}]};
  installedSkill.head={...installedSkill.head,revision:3,staged_digest:stagedDigest};
  await page.locator('[data-product-refresh]').click();await status.filter({hasText:'List refreshed.'}).waitFor();
  const skillCard=page.locator('[data-skill-list] .central-card');
  assert.equal(await skillCard.getByText('Update available.',{exact:true}).isVisible(),true);
  await skillCard.getByRole('button',{name:'View files',exact:true}).click();await status.filter({hasText:'Skill files loaded.'}).waitFor();
  assert.equal(await skillReview.locator('pre').textContent(),stagedText);assert.equal(installedSkill.head.active_digest,digest);assert.equal(skillWrites(),beforeReview);
  assert.equal(await skillReview.getByRole('button',{name:'Update Skill',exact:true}).count(),1,'An enabled Skill with a staged update needs an explicit publication action');
  await skillReview.getByRole('button',{name:'Update Skill',exact:true}).click();await status.filter({hasText:'List refreshed.'}).waitFor();
  assert.equal(installedSkill.head.active_digest,stagedDigest);assert.equal(installedSkill.head.revision,4);assert.equal(skillWrites(),beforeReview+1);
  assert.equal(await skillCard.getByText('Update available.',{exact:true}).count(),0);
  await skillCard.getByRole('button',{name:'View files',exact:true}).click();await status.filter({hasText:'Skill files loaded.'}).waitFor();
  assert.equal(await skillReview.getByRole('button',{name:'Update Skill',exact:true}).count(),0);assert.equal(await skillReview.getByRole('button',{name:'Enable Skill',exact:true}).count(),0);
  await skillCard.getByRole('button',{name:'Pause',exact:true}).click();await status.filter({hasText:'List refreshed.'}).waitFor();
  assert.equal(installedSkill.head.enabled,false);assert.equal(installedSkill.head.active_digest,stagedDigest);
  await skillCard.getByRole('button',{name:'View files',exact:true}).click();await status.filter({hasText:'Skill files loaded.'}).waitFor();
  await skillReview.getByRole('button',{name:'Enable Skill',exact:true}).click();await status.filter({hasText:'List refreshed.'}).waitFor();
  assert.equal(installedSkill.head.enabled,true);assert.equal(installedSkill.head.active_digest,stagedDigest);assert.equal(installedSkill.head.revision,6);
  // Valid user content must remain readable inside its panel, including text clipped by ancestor overflow.
  const longSkillName='s'.repeat(64),longSkillPath='p'.repeat(197)+'.md';
  const longSkillFiles=[{path:'SKILL.md',text:['---','name: '+longSkillName,'description: '+'D'.repeat(512),'---','Skill instructions.'].join(String.fromCharCode(10))},{path:longSkillPath,text:'T'.repeat(600)}];
  assert.ok(skillInstallation({files:longSkillFiles,expected_revision:0}),'The long-content regression must use a valid Skill package');
  const fits=locator=>locator.evaluate(node=>node.scrollWidth<=node.clientWidth+1&&node.getBoundingClientRect().right<=innerWidth+1);
  await page.setViewportSize({width:390,height:844});
  await importer.locator('[name=files]').setInputFiles(longSkillFiles.map(file=>({name:file.path,mimeType:'text/markdown',buffer:Buffer.from(file.text)})));
  await importer.getByRole('button',{name:'Install Skill',exact:true}).click();await status.filter({hasText:longSkillName+' installed.'}).waitFor();
  assert.equal(await fits(status),true,'A long Skill name must not clip its installation status');
  const longSkillCard=page.locator('[data-skill-list] .central-card').filter({has:page.getByRole('heading',{name:longSkillName,exact:true})});
  assert.equal(await longSkillCard.locator('h3').evaluate(node=>getComputedStyle(node).textTransform),'none');
  for(const heading of await page.locator('[data-service-list] h3').all())assert.equal(await heading.evaluate(node=>getComputedStyle(node).textTransform),'none');
  await longSkillCard.getByRole('button',{name:'View files',exact:true}).click();await status.filter({hasText:'Skill files loaded.'}).waitFor();
  for(const summary of await skillReview.locator('summary').all())await summary.click();
  for(const width of [390,1365]){
   await page.setViewportSize({width,height:1000});
   for(const node of await skillReview.locator('h2,p,summary,pre').all())assert.equal(await fits(node),true,'Skill names, descriptions, paths and text must fit their panel');
  }
  library.splice(library.findIndex(item=>item.head.skill_id===longSkillName),1);
  await page.locator('[data-product-refresh]').click();await status.filter({hasText:'List refreshed.'}).waitFor();
  // Publication conflict cannot trigger automatic replay, even after repeated clicks.
  await page.locator('[data-central-tab=services]').click();
  await page.locator('[data-service-list]').getByRole('button',{name:'View tools',exact:true}).first().click();await status.filter({hasText:'Tools loaded.'}).waitFor();
  controls.discovery.conflict=true;await page.locator('[data-service-list]').getByRole('button',{name:'Refresh tools',exact:true}).first().click();await status.filter({hasText:'This item has changed. Refresh before saving.'}).waitFor();
  const writes=requests.filter(r=>r.method==='POST').length;await page.locator('[data-service-list]').getByRole('button',{name:'Refresh tools',exact:true}).first().click();await status.filter({hasText:'Refresh before making another change.'}).waitFor();assert.equal(requests.filter(r=>r.method==='POST').length,writes);
  controls.discovery.conflict=false;await page.locator('[data-product-refresh]').click();await status.filter({hasText:'List refreshed.'}).waitFor();assert.equal(await review.isHidden(),true);
  await page.goto(origin+'/admin/central?client=client-fixture');await status.filter({hasText:'List refreshed.'}).waitFor();
  assert.equal(await page.locator('[data-central-tab=access],[data-client-select],[data-client-access]').count(),0);
  assert.equal(requests.filter(r=>/\/(grants|toolsets)\//.test(r.path)).length,0);
  controls.library.unavailable=true;await page.locator('[data-product-refresh]').click();await status.filter({hasText:'Could not confirm the result. Refresh to check the status.'}).waitFor();
  const mutations=requests.filter(r=>r.method==='POST').length;await page.locator('[data-service-list]').getByRole('button',{name:'Pause',exact:true}).first().click();await status.filter({hasText:'Refresh before making another change.'}).waitFor();assert.equal(requests.filter(r=>r.method==='POST').length,mutations);
  controls.library.unavailable=false;await page.locator('[data-product-refresh]').click();await status.filter({hasText:'List refreshed.'}).waitFor();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  const callback=await page.context().newPage();callback.on('pageerror',e=>exceptions.push(e.message));
  for(const locale of ['en','zh-CN']){
   const path='/admin/central/connections', chinese=locale==='zh-CN';
   await callback.setViewportSize({width:390,height:844});
   await callback.goto(origin+path+'/callback?state=cancel-state&error=access_denied&error_description=PRIVATE_PROVIDER_DETAIL&error_uri=https://provider.com/error&lang='+locale);
   await callback.getByText(chinese?'授权已取消，可返回 MCP 和 Skill 重新连接。':'Authorization was cancelled. You can connect again from MCP & Skill.',{exact:true}).waitFor();
   assert.equal(new URL(callback.url()).search,'');assert.equal((await callback.content()).includes('PRIVATE_PROVIDER_DETAIL'),false);
   assert.equal(await callback.locator('.app-header').isVisible(),true);
   assert.equal(await callback.locator('.auth-card.secret-card').isVisible(),true);
   assert.equal(await callback.getByRole('link',{name:chinese?'返回 MCP 和 Skill':'Back to MCP & Skill',exact:true}).getAttribute('href'),'/admin/central');
   assert.equal(await callback.locator('[data-oauth-callback]').getAttribute('aria-busy'),'false');
   assert.equal(await callback.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   assert.notEqual(await callback.locator('.auth-card').evaluate(element=>getComputedStyle(element).backgroundColor),'rgba(0, 0, 0, 0)');
   const callbacks=requests.filter(r=>r.path===path+'/complete').length;
   for(const duplicate of ['state=one&state=two&code=unused','state=one&code=unused&code=again','state=one&code=unused&iss=one&iss=two','state=one&error=access_denied&error=again']){
    await callback.goto(origin+path+'/callback?'+duplicate+'&lang='+locale);await callback.getByText(chinese?'请返回 MCP 和 Skill，重新开始授权。':'Return to MCP & Skill and start authorization again.',{exact:true}).waitFor();assert.equal(new URL(callback.url()).search,'');
   }
   assert.equal(requests.filter(r=>r.path===path+'/complete').length,callbacks);
   controls.oauth.rejectComplete=true;
   await callback.setViewportSize({width:1365,height:1000});
   await callback.goto(origin+path+'/callback?state=fixture-state&code=fixture-code&iss=https://login.provider.com&lang='+locale);
   await callback.getByText(chinese?'暂时无法确认连接结果，请返回查看状态。':'We could not confirm the connection. Return to check its status.',{exact:true}).waitFor();
   assert.equal(await callback.getByRole('heading',{name:chinese?'连接尚未完成':'Connection not completed',exact:true}).isVisible(),true);
   assert.equal(new URL(callback.url()).search,'');
   assert.equal(requests.filter(r=>r.path===path+'/complete').length,callbacks+1);
   assert.equal(await callback.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   await callback.getByRole('link',{name:chinese?'返回 MCP 和 Skill':'Back to MCP & Skill',exact:true}).click();
   assert.equal(new URL(callback.url()).pathname,'/admin/central');
   controls.oauth.rejectComplete=false;
  }
  await callback.close();
  // A list receipt is not proof that a discovery publication succeeded.
  controls.discovery.invalidReceipt=true;
  await page.locator('[data-service-list]').getByRole('button',{name:'View tools',exact:true}).first().click();await status.filter({hasText:'Tools loaded.'}).waitFor();
  const beforeInvalidReceipt=requests.filter(r=>r.method==='POST').length, approvedRevision=catalogs.get(profiles[0].profile_id).head.revision;
  await page.locator('[data-service-list]').getByRole('button',{name:'Refresh tools',exact:true}).first().click();await status.filter({hasText:'Unexpected response.'}).waitFor();
  assert.equal(catalogs.get(profiles[0].profile_id).head.revision,approvedRevision);assert.equal(await status.getAttribute('data-error'),'true');
  await page.locator('[data-service-list]').getByRole('button',{name:'Refresh tools',exact:true}).first().click();await status.filter({hasText:'Refresh before making another change.'}).waitFor();
  assert.equal(requests.filter(r=>r.method==='POST').length,beforeInvalidReceipt+1);
  controls.discovery.invalidReceipt=false;await page.locator('[data-product-refresh]').click();await status.filter({hasText:'List refreshed.'}).waitFor();
  // Removed page instances must not redirect or continue an old workflow.
  let releaseOAuth;controls.oauth.delayed=new Promise(resolve=>{releaseOAuth=resolve;});
  const pendingOAuth=page.waitForRequest(request=>request.url().endsWith('/connections/begin'));
  await page.getByRole('button',{name:'Reconnect',exact:true}).click();await pendingOAuth;
  assert.equal(await status.textContent(),'Opening the MCP sign-in page…','Internal reconciliation must not replace sign-in progress with List refreshed');
  await page.locator('.control-nav a[href="/admin"]').click();await page.waitForURL(url=>url.pathname==='/admin');
  assert.equal(await page.locator('[data-central-product]').count(),0);
  const settledOAuth=page.waitForResponse(response=>response.url().endsWith('/connections/begin'));
  releaseOAuth();await(await settledOAuth).finished();await page.waitForLoadState('networkidle');controls.oauth.delayed=undefined;
  assert.equal(new URL(page.url()).pathname,'/admin');assert.equal(await page.getByRole('heading',{name:'Use your tools across AI clients'}).count(),1);
  await page.locator('.control-nav a[href="/admin/central"]').click();await status.filter({hasText:'List refreshed.'}).waitFor();
  await page.locator('[data-central-product][aria-busy="false"]').waitFor();
  assert.equal(await page.getByRole('button',{name:'Reconnect',exact:true}).isEnabled(),true);
  assert.equal(requests.filter(r=>r.path.includes('/catalogs/')&&r.method==='POST').length,0);
  assert.equal(await page.getByText('Enabled · tool review required before sharing',{exact:true}).count(),0);
  // A broken service must not strand another pending service or replay the failed write.
  const publicId=profiles[0].profile_id;
  const discoveryPath=id=>'/admin/central/discovery/'+id;
  catalogs.delete(publicId);catalogs.delete(oauthId);controls.discovery.rejectedProfile=publicId;
  const recoveryStart=requests.length;
  await page.reload();await status.filter({hasText:'Select Reconnect to sign in to this MCP again.'}).waitFor();await page.waitForLoadState('networkidle');
  assert.ok(catalogs.has(oauthId),'A healthy pending service must recover after another service fails');
  const recovery=requests.slice(recoveryStart),failedIndex=recovery.findIndex(r=>r.path===discoveryPath(publicId)),healthyIndex=recovery.findIndex(r=>r.path===discoveryPath(oauthId));
  assert.equal(recovery.filter(r=>r.path===discoveryPath(publicId)).length,1);
  assert.equal(recovery.filter(r=>r.path===discoveryPath(oauthId)).length,1);
  assert.ok(recovery.slice(failedIndex+1,healthyIndex).some(r=>r.path==='/admin/central/profiles'&&r.method==='GET'),'Refresh admission before a different service writes');
  assert.ok((await status.textContent()).includes('团队文档'));assert.equal(await status.getAttribute('data-error'),'true');
  // A failed refresh must still stop later recovery writes.
  catalogs.delete(oauthId);controls.discovery.failRefreshAfterRejection=true;
  const blockedStart=requests.length;
  await page.reload();await status.filter({hasText:'Could not confirm the result. Refresh to check the status.'}).waitFor();await page.waitForLoadState('networkidle');
  assert.equal(requests.slice(blockedStart).filter(r=>r.path===discoveryPath(oauthId)).length,0);
  controls.discovery.rejectedProfile=undefined;controls.discovery.failRefreshAfterRejection=false;controls.library.unavailable=false;
  // OAuth return finishes its own connection and other interrupted connections once each.
  const callbackStart=requests.length;
  await page.goto(origin+'/admin/central?connected='+oauthId);await status.filter({hasText:'Connected.'}).waitFor();await page.waitForLoadState('networkidle');
  for(const id of [publicId,oauthId])assert.equal(requests.slice(callbackStart).filter(r=>r.path===discoveryPath(id)).length,1);
  assert.equal(new URL(page.url()).search,'');
  // The refreshed state, rather than an earlier successful write, determines readiness.
  for(const state of ['paused','missing','unpublished']){
   controls.discovery.after=id=>{if(state==='paused'){const p=profiles.find(p=>p.profile_id===id);p.enabled=false;p.revision++;}else if(state==='missing')catalogs.delete(id);else catalogs.get(id).head.approved_names=[];};
   await publicCard.getByRole('button',{name:'Refresh tools',exact:true}).click();
   await status.filter({hasText:state==='paused'?'This MCP is paused or unavailable. Refresh to check its status.':'Could not finish loading tools. Select Refresh tools to try again.'}).waitFor();
   assert.equal((await status.textContent()).includes('Connected.'),false,'Do not announce ready after '+state);
   assert.equal(await status.getAttribute('data-error'),'true',state+': '+await status.textContent());
   assert.equal(await review.getByText('Tools from enabled services are available to all connected AI clients automatically.',{exact:true}).count(),0);
   if(state==='paused')await publicCard.getByRole('button',{name:'Enable',exact:true}).click();
   else await publicCard.getByRole('button',{name:'Refresh tools',exact:true}).click();
   await status.filter({hasText:'Connected.'}).waitFor();
  }
  // A concurrent pause or replacement must not be reported as an active installation.
  await page.locator('[data-central-tab=skills]').click();
  for(const state of ['paused','replaced']){
   await importer.locator('[name=files]').setInputFiles({name:'SKILL.md',mimeType:'text/markdown',buffer:Buffer.from(folderText)});
   await importer.getByRole('button',{name:'Install Skill',exact:true}).click();await status.filter({hasText:'This Skill is already installed.'}).waitFor();
   controls.skills.afterInstallation=entry=>{entry.head.revision++;if(state==='paused')entry.head.enabled=false;else{entry.head.active_digest=entry.head.staged_digest='b'.repeat(64);entry.bundle.digest=entry.head.active_digest;}};
   await skillReview.getByRole('button',{name:'Update Skill',exact:true}).click();
   await page.waitForFunction(()=>{const text=document.querySelector('[data-product-status]').textContent;return text.includes('research installed.')||text.includes('The Skill has changed. Refresh to view its current version.');});
   assert.equal((await status.textContent()).includes('research installed.'),false,'Do not report an active installation after '+state);
   assert.equal(await status.getAttribute('data-error'),'true');
  }
  // Recreated controls must reflect the operation lock until recovery finishes.
  catalogs.delete(publicId);
  profiles.find(p=>p.profile_id===oauthId).enabled=false;
  let releaseDiscovery;controls.discovery.delayed=new Promise(resolve=>{releaseDiscovery=resolve;});
  const pendingDiscovery=page.waitForRequest(request=>request.url().endsWith('/discovery/'+publicId));
  try{
   await page.reload();await pendingDiscovery;
   assert.equal(await publicCard.getByRole('button',{name:'View tools',exact:true}).isDisabled(),true,'Newly rendered service controls must stay disabled while recovery runs');
   assert.equal(await oauthCard.getByRole('button',{name:'Enable',exact:true}).isDisabled(),true);
   assert.equal(await page.locator('[data-central-product]').getAttribute('aria-busy'),'true');
  }finally{releaseDiscovery();controls.discovery.delayed=undefined;}
  await status.filter({hasText:'Connected.'}).waitFor();
  assert.equal(await publicCard.getByRole('button',{name:'Refresh tools',exact:true}).isEnabled(),true);
  assert.equal(await oauthCard.getByRole('button',{name:'Refresh tools',exact:true}).isDisabled(),true);
  assert.equal(await oauthCard.getByRole('button',{name:'Enable',exact:true}).isEnabled(),true);
  assert.equal(await page.locator('[data-central-product]').getAttribute('aria-busy'),'false');
  // A valid long hostname must still connect with the optional name left blank.
  const longEndpoint='https://docs-'+ 'a'.repeat(55) +'.example.com/mcp';
  await form.locator('[name=name]').fill('');await form.locator('[name=endpoint]').fill(longEndpoint);await form.locator('button').click();
  await page.waitForFunction(()=>{const text=document.querySelector('[data-product-status]').textContent;return text.includes('Connected.')||text.includes('Check the service name');});
  assert.equal(profiles.at(-1).endpoint,longEndpoint,'An automatic display name must not reject a valid service URL');
  assert.equal(profiles.at(-1).display_name.length<=64,true);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await review.locator('h2').textContent(),profiles.at(-1).display_name);
  assert.equal(await review.evaluate(panel=>{
   const bounds=panel.getBoundingClientRect();
   return [...panel.querySelectorAll('.section-title h2,.section-title span')].every(node=>{
    const box=node.getBoundingClientRect();
    return box.left>=bounds.left&&box.right<=bounds.right&&node.scrollWidth<=node.clientWidth+1;
   });
  }),true,'Long MCP names and tool counts must fit their panel, not be clipped by the page');
  await page.setViewportSize({width:1365,height:1000});
  // A failed sign-in handoff must leave the already saved service visible.
  controls.oauth.rejectStart=true;
  const failedOAuthStart=requests.length;
  await form.locator('[name=name]').fill('Failed sign-in service');
  await form.locator('[name=endpoint]').fill('https://unavailable.provider.com/mcp');
  await form.locator('[name=authentication]').selectOption('oauth');await form.locator('button').click();
  await status.filter({hasText:'Could not set up OAuth. Check the MCP URL and its support for automatic client registration.'}).waitFor();
  const savedOAuth=profiles.at(-1);
  const savedOAuthCard=page.locator('[data-service-list] .central-card').filter({has:page.getByText(savedOAuth.endpoint,{exact:true})});
  assert.equal(await savedOAuthCard.count(),1,'A saved service must remain visible when OAuth setup fails');
  assert.equal(await savedOAuthCard.getByRole('button',{name:'Reconnect',exact:true}).isVisible(),true);
  assert.equal(requests.slice(failedOAuthStart).filter(r=>r.body?.action==='connect').length,1);
  assert.equal(requests.slice(failedOAuthStart).filter(r=>r.path==='/admin/central/connections/begin').length,1);
  const retryStart=requests.length;
  savedOAuth.revision++;
  await savedOAuthCard.getByRole('button',{name:'Reconnect',exact:true}).click();
  await status.filter({hasText:'Could not set up OAuth. Check the MCP URL and its support for automatic client registration.'}).waitFor();
  const retry=requests.slice(retryStart),beginIndex=retry.findIndex(r=>r.path==='/admin/central/connections/begin');
  assert.ok(retry.slice(0,beginIndex).some(r=>r.path==='/admin/central/profiles'&&r.method==='GET'),'An explicit reconnect must reconcile an earlier failure first');
  assert.equal(retry[beginIndex].body.expected_revision,savedOAuth.revision,'Use the refreshed profile revision');
  assert.equal(retry.filter(r=>r.path==='/admin/central/connections/begin').length,1,'Start once per explicit reconnect');
  controls.oauth.rejectStart=false;
  await savedOAuthCard.getByRole('button',{name:'Reconnect',exact:true}).click();
  await status.filter({hasText:'Connected.'}).waitFor();
  assert.equal(requests.slice(failedOAuthStart).filter(r=>r.body?.action==='connect').length,1,'Recover the saved service without creating a duplicate');
  assert.equal(requests.slice(failedOAuthStart).filter(r=>r.path==='/admin/central/connections/begin').length,3);
  assert.ok(catalogs.has(savedOAuth.profile_id));
  // Another tab may pause the MCP after this card was rendered.
  savedOAuth.enabled=false;savedOAuth.revision++;
  const pausedRetry=requests.length;
  await savedOAuthCard.getByRole('button',{name:'Reconnect',exact:true}).click();
  await status.filter({hasText:'This MCP is paused or unavailable. Refresh to check its status.'}).waitFor();
  assert.equal(requests.slice(pausedRetry).filter(r=>r.path==='/admin/central/connections/begin').length,0);
  assert.equal(await savedOAuthCard.getByRole('button',{name:'Reconnect',exact:true}).isDisabled(),true);
  assert.deepEqual(exceptions,[]);
  return {state:'passed',guided_homepage:true,direct_url_without_deployment_setup:true,service_immediate_tools:true,existing_connections_complete_automatically:true,pending_service_failure_isolation:true,recovery_refresh_failure_blocks_writes:true,oauth_return_recovers_other_services:true,connection_success_uses_refreshed_state:true,oauth_return_to_available_tools:true,paused_oauth_reconnect_guard:true,paused_service_discovery_guard:true,resume_refreshes_tools:true,no_legacy_service_credentials:true,oauth_extra_parameters_ignored:true,oauth_duplicate_parameters_rejected:true,oauth_provider_errors_not_reflected:true,direct_skill_install_and_confirmed_update:true,skill_file_folder_selection_switch:true,skill_selection_invalidates_confirmation:true,skill_pending_update_publication:true,skill_pause_and_resume:true,shared_library_without_client_assignment:true,retired_access_api_not_called:true,failed_refresh_blocks_writes:true,conflict_no_replay:true,malformed_write_receipt_blocks_replay:true,detached_oauth_does_not_navigate:true,mobile_no_overflow:true,screenshots:0};
 }finally{await browser?.close();await fixture.close();await rm(join(skillFolder,'SKILL.md'),{force:true});await rmdir(skillFolder);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 console.log(JSON.stringify(await checkGuidedProduct(process.env.RUNMESH_CHROMIUM_EXECUTABLE)));
}
