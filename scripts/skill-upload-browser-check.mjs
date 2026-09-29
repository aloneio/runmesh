import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_LIMITS } from '../apps/worker/dist/contracts/skills.js';

/** Real directory selection and DOM assertions only; no screenshots. */
export async function checkSkillUploads(browser, origin, requests, library) {
 const directory=await mkdtemp(join(tmpdir(),'runmesh-large-skill-'));
 const main='---\nname: large-folder\ndescription: Larger Skill upload\n---\nRead the references.';
 const files=[{name:'SKILL.md',text:main},...Array.from({length:SKILL_LIMITS.files-1},(_,n)=>({name:'reference-'+n+'.txt',text:n<3?'x'.repeat(SKILL_LIMITS.file_bytes):'reference'}))];
 try {
  await Promise.all(files.map(file=>writeFile(join(directory,file.name),file.text)));
  for(const locale of ['en','zh-CN']){
   const page=await browser.newPage();
   try {
    await page.goto(origin+'/admin/central?lang='+locale);
    await page.locator('[data-central-product][aria-busy="false"]').waitFor();
    await page.locator('[data-central-tab=skills]').click();
    const form=page.locator('[data-skill-import]'),status=page.locator('[data-product-status]');
    assert.equal(Number(await form.getAttribute('data-max-files')),SKILL_LIMITS.files);
    assert.equal(Number(await form.getAttribute('data-max-file-bytes')),SKILL_LIMITS.file_bytes);
    assert.equal(Number(await form.getAttribute('data-max-bundle-bytes')),SKILL_LIMITS.bundle_bytes);
    const count=()=>requests.filter(request=>request.path==='/admin/central/skill-installations').length;
    const before=count();
    const file=(name,text)=>({name,mimeType:'text/plain',buffer:Buffer.from(text)});
    const mainFile=file('SKILL.md',main);
    const invalid=[
     [mainFile,file('large.txt','x'.repeat(SKILL_LIMITS.file_bytes+1))],
     [mainFile,...Array.from({length:SKILL_LIMITS.files},(_,n)=>file(n+'.txt','text'))],
     [mainFile,...Array.from({length:8},(_,n)=>file(n+'.txt','x'.repeat(SKILL_LIMITS.file_bytes)))],
     [mainFile,...Array.from({length:4},(_,n)=>file(n+'.txt','"'.repeat(SKILL_LIMITS.file_bytes)))],
    ];
    for(const selection of invalid){
     await form.locator('[name=files]').setInputFiles(selection);
     await form.locator('[type=submit]').click();
     await page.locator('[data-central-product][aria-busy="false"]').waitFor();
     assert.match(await status.textContent(),locale==='en'?/Select 1–256 text files.*1 MiB.*8 MiB/u:/请选择 1–256 个文本文件.*1 MiB.*8 MiB/u);
     assert.equal(await status.getAttribute('data-error'),'true');
     assert.equal(count(),before);
    }
    // Confirmed rejection allows reselection without a forced refresh.
    await page.route('**/admin/central/skill-installations',route=>route.fulfill({status:413,contentType:'application/json',body:JSON.stringify({error:{code:'central_request_too_large',operation_state:'not_started'}})}));
    await form.locator('[name=files]').setInputFiles(mainFile);
    await form.locator('[type=submit]').click();
    await status.filter({hasText:locale==='en'?'The Skill upload is too large.':'Skill 上传包过大'}).waitFor();
    await page.unroute('**/admin/central/skill-installations');
    await form.locator('[name=folder]').setInputFiles(directory);
    await form.locator('[type=submit]').click();
    await status.filter({hasText:'large-folder'+(locale==='en'?' installed.':' 已安装。')}).waitFor();
    assert.equal(count(),before+1);
    assert.equal(library[0].bundle.files.length,SKILL_LIMITS.files);
    assert.equal(library[0].bundle.files.find(file=>file.path==='reference-0.txt').text.length,SKILL_LIMITS.file_bytes);
    assert.equal(library[0].head.enabled,true);
   } finally {await page.close();library.length=0;}
  }
 } finally {
  await Promise.all(files.map(file=>unlink(join(directory,file.name)).catch(error=>{if(error.code!=='ENOENT')throw error;})));
  await rmdir(directory);
 }
}
