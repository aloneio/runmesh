import assert from 'node:assert/strict';
import { SKILL_LIMITS } from '../apps/worker/dist/contracts/skills.js';
import { localizeFixture } from './layout-browser-check.mjs';

/** Real browser interactions use an isolated API fixture, with no external resources. */
export async function checkCentralManagement(browser, origin) {
 for (const locale of ['en', 'zh-CN']) {
  console.log('central-management-browser: ' + locale + ' start');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const copy = (en, zh) => locale === 'en' ? en : zh;
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const digest = number => number.toString(16).padStart(64, '0');
  const head = { skill_id: 'research', revision: 1, active_digest: digest(1), staged_digest: digest(2), enabled: true };
  const summary = { name: 'Research', description: 'Team research', source: 'local', license: 'MIT' };
  const versions = Array.from({ length: SKILL_LIMITS.versions }, (_, index) => ({ digest: digest(index + 1), bytes: 100,
   file_count: 1, created_at_ms: null, pinned: index === 2, summary: { ...summary, description: 'Research version ' + (index + 1) } }));
  let sourceInstalled = false, plan;
  const source = { repository: 'https://github.com/example/skills', commit: 'a'.repeat(40), path: 'skills/github-research' };
  const sourceBundle = { schema_version: 1, skill_id: 'github-research', name: 'GitHub research', description: 'Repository Skill',
   source: source.repository + '/tree/' + source.commit + '/' + source.path, license: 'MIT', digest: digest(100), files: [{ path: 'SKILL.md', text: '# GitHub research' }] };
  const sourceHead = { skill_id: sourceBundle.skill_id, revision: 1, active_digest: sourceBundle.digest, staged_digest: sourceBundle.digest, enabled: true };
  const capacity = () => ({ skill_bytes: versions.length * 100, skill_versions: versions.length, library_bytes: versions.length * 100,
   library_skills: sourceInstalled ? 2 : 1, max_versions: SKILL_LIMITS.versions, max_library_bytes: SKILL_LIMITS.storage_bytes, max_skills: SKILL_LIMITS.skills });
  await page.route('**/admin/central/**', async route => {
   const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/admin/central/', '');
   const body = request.postDataJSON() ?? undefined;
   requests.push({ path, body, digest: url.searchParams.get('digest') });
   let value, status = 200;
   if (path === 'profiles') value = { state: 'listed', profiles: [], next_after: null };
   else if (path === 'skills') value = { state: 'listed', skills: [{ head, summary: versions.find(version => version.digest === (head.active_digest ?? head.staged_digest)).summary }, ...(sourceInstalled ? [{ head: sourceHead, summary: sourceBundle }] : [])], next_after: null };
   else if (path === 'skills/research/versions') value = { state: 'listed', head, capacity: capacity(), versions: versions.map(version => ({ ...version, active: version.digest === head.active_digest, staged: version.digest === head.staged_digest })) };
   else if (path === 'skills/research/cleanup-preview') {
    assert.equal(body.expected_revision, head.revision);
    plan = { fingerprint: digest(201), skill_id: head.skill_id, revision: head.revision, digests: body.digests, bytes: body.digests.length * 100, expires_at_ms: Date.now() + 300000 };
    value = { state: 'previewed', plan };
   } else if (path === 'skills/research/cleanup') {
    assert.equal(body.confirm, true); assert.equal(body.fingerprint, plan.fingerprint); assert.equal(body.expected_revision, head.revision);
    for (const selected of plan.digests) versions.splice(versions.findIndex(version => version.digest === selected), 1);
    head.revision++;
    value = { state: 'cleaned', skill_id: head.skill_id, head, deleted_digests: plan.digests, freed_bytes: plan.bytes, capacity: capacity() };
   } else if (path === 'skills/research/retention') {
    assert.equal(body.expected_revision, head.revision);
    versions.find(version => version.digest === body.digest).pinned = body.pinned; head.revision++;
    value = { state: 'retained', head, digest: body.digest, pinned: body.pinned };
   } else if (path === 'skills/research/compare') value = { state: 'compared', skill_id: head.skill_id, revision: head.revision,
    before: body.before, after: body.after, metadata: [{ field: 'license', before: 'MIT', after: 'ISC' }],
    files: [{ path: 'SKILL.md', change: 'modified', before_bytes: 20000, after_bytes: 30000, before_text: '# Before', after_text: '# After excerpt', truncated: true }], truncated: true };
   else if (path === 'skills/research') {
    if (body) {
     assert.ok(['activate', 'disable'].includes(body.action)); assert.equal(body.expected_revision, head.revision);
     if (body.action === 'activate') { assert.ok(versions.some(version => version.digest === body.digest)); head.active_digest = body.digest; }
     head.enabled = body.action === 'activate'; head.revision++; value = { state: 'written', head };
    } else {
     const selected = versions.find(version => version.digest === (url.searchParams.get('digest') ?? head.staged_digest));
     assert.ok(selected);
     value = { state: 'found', head, bundle: { ...selected.summary, skill_id: head.skill_id, digest: selected.digest, files: [{ path: 'SKILL.md', text: '# Complete Skill file · ' + selected.summary.description }] } };
    }
   } else if (path === 'skill-installations') {
    if (body.expected_revision !== head.revision) { status = 409; value = { state: 'conflict', skill_id: head.skill_id, current_revision: head.revision }; }
    else if (versions.length >= SKILL_LIMITS.versions) { status = 429; value = { error: { code: 'skill_capacity', operation_state: 'not_started' } }; }
    else { head.revision++; head.active_digest = head.staged_digest = digest(90); versions.push({ digest: digest(90), bytes: 100, file_count: 1, created_at_ms: Date.now(), pinned: false, summary: { ...summary, description: 'Research version 90' } }); value = { state: 'installed', skill_id: head.skill_id, name: summary.name, digest: head.active_digest }; }
   } else if (path === 'skill-source/preview') value = { state: 'previewed', source: body.source, bundle: sourceBundle };
   else if (path === 'skill-source/install') { assert.equal(body.digest, sourceBundle.digest); assert.equal(body.expected_revision, 0); sourceInstalled = true; value = { state: 'written', head: sourceHead }; }
   else if (path === 'connection-check') value = body.endpoint.includes('oauth') ? { state: 'authorization_required' }
    : { state: 'inspected', endpoint: body.endpoint, server: { protocol_version: '2025-11-25', capabilities: { tools: true, resources: true, prompts: false, tasks: true, apps: false } }, tools_count: 2, observed_at_ms: Date.now() };
   else if (path === 'registry-preview') value = { state: 'previewed', name: 'example/mcp', version: '1.0.0', description: 'Team service', schema: null,
    remotes: [{ endpoint: 'https://registry.example/mcp', transport: 'streamable-http', mode: 'connect', headers: [] }],
    packages: [{ registry: 'npm', identifier: 'team-mcp', version: '1.0.0' }], digest: digest(200), observed_at_ms: Date.now() };
   else { await route.continue(); return; }
   await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  });
  const idle = () => page.locator('[data-central-product][aria-busy="false"]').waitFor();
  try {
   await page.goto(origin + '/admin/central?lang=' + locale); await idle();
   await localizeFixture(page, locale);
   await page.locator('[data-central-tab=skills]').click();
   const importer = page.locator('[data-skill-import]'), review = page.locator('[data-skill-review]'), history = page.locator('[data-skill-history]');
   await importer.locator('[name=files]').setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: research\ndescription: Research\n---\nNew version') });
   await importer.locator('[type=submit]').click(); await review.waitFor();
   await review.getByRole('button', { name: copy('Update Skill', '更新 Skill'), exact: true }).click(); await history.waitFor(); await idle();
   assert.equal(await importer.locator('[name=files]').evaluate(node => node.files.length), 1, 'Capacity recovery preserves the selected upload');
   assert.match(await history.textContent(), new RegExp(SKILL_LIMITS.versions + ' / ' + SKILL_LIMITS.versions));
   await history.locator('input[type=checkbox]').first().check();
   await history.getByRole('button', { name: copy('Preview cleanup', '预览清理'), exact: true }).click(); await idle();
   assert.equal(requests.filter(request => request.path.endsWith('/cleanup')).length, 0);
   await history.getByRole('button', { name: copy('Confirm', '确认'), exact: true }).click(); await idle();
   assert.equal(versions.length, SKILL_LIMITS.versions - 1);
   await importer.locator('[type=submit]').click(); await review.waitFor();
   await review.getByRole('button', { name: copy('Update Skill', '更新 Skill'), exact: true }).click(); await idle();
   assert.equal(versions.length, SKILL_LIMITS.versions);
   console.log('central-management-browser: ' + locale + ' capacity-recovery passed');
   await page.locator('[data-skill-list]').getByRole('button', { name: copy('Version history', '版本记录'), exact: true }).click(); await idle();
   await history.getByRole('button', { name: copy('Compare versions', '比较版本'), exact: true }).click(); await idle();
   assert.match(await history.textContent(), locale === 'en' ? /Showing an excerpt/u : /当前显示内容片段/u);
   await history.getByRole('button', { name: copy('View after files', '查看更改后文件'), exact: true }).click(); await idle();
   await review.locator('summary').click();
   assert.match(await review.textContent(), /Complete Skill file/u);
   await history.getByRole('button', { name: copy('Keep version', '保留版本'), exact: true }).first().click(); await idle();
   await history.getByRole('button', { name: copy('Unpin version', '取消保留'), exact: true }).first().click(); await idle();
   await history.getByRole('button', { name: copy('Use this version', '使用此版本'), exact: true }).first().click(); await idle();
   await history.getByRole('button', { name: copy('Confirm', '确认'), exact: true }).click(); await idle();
   assert.equal(requests.filter(request => request.body?.action === 'activate').length, 1);
   assert.equal(head.active_digest, digest(1));
   assert.equal(head.staged_digest, digest(90));
   const skillCard = page.locator('[data-skill-list] .central-card');
   assert.equal(await skillCard.getByText('Research version 1', { exact: true }).isVisible(), true);
   await skillCard.getByRole('button', { name: copy('Pause', '暂停'), exact: true }).click(); await idle();
   await skillCard.getByRole('button', { name: copy('View files', '查看文件'), exact: true }).click(); await idle();
   assert.equal(requests.filter(request => request.path === 'skills/research' && !request.body).at(-1).digest, digest(1));
   assert.match(await review.textContent(), /Research version 1/u);
   await review.getByRole('button', { name: copy('Enable Skill', '启用 Skill'), exact: true }).click(); await idle();
   assert.equal(head.active_digest, digest(1));
   assert.equal(head.staged_digest, digest(90));
   await skillCard.getByRole('button', { name: copy('View latest upload', '查看最近上传'), exact: true }).click(); await idle();
   assert.equal(requests.filter(request => request.path === 'skills/research' && !request.body).at(-1).digest, digest(90));
   assert.match(await review.textContent(), /Research version 90/u);
   assert.equal(head.active_digest, digest(1), 'Opening the latest upload keeps the selected version unchanged');
   await review.getByRole('button', { name: copy('Update Skill', '更新 Skill'), exact: true }).click(); await idle();
   assert.equal(head.active_digest, digest(90));
   assert.equal(await skillCard.getByRole('button', { name: copy('View latest upload', '查看最近上传'), exact: true }).count(), 0);
   console.log('central-management-browser: ' + locale + ' history-actions passed');
   await page.getByText(copy('Import from GitHub', '从 GitHub 导入'), { exact: true }).click();
   const sourceForm = page.locator('[data-skill-source]'), sourceReview = page.locator('[data-skill-source-preview]');
   for (const [key, value] of Object.entries(source)) await sourceForm.locator('[name=' + key + ']').fill(value);
   await sourceForm.locator('[type=submit]').click(); await sourceReview.waitFor(); await idle();
   assert.equal(requests.filter(request => request.path === 'skill-source/install').length, 0);
   await sourceForm.locator('[name=commit]').fill('b'.repeat(40)); assert.equal(await sourceReview.isVisible(), false);
   await sourceForm.locator('[name=commit]').fill(source.commit);
   await sourceForm.locator('[type=submit]').click(); await sourceReview.waitFor(); await idle();
   await sourceReview.getByRole('button', { name: copy('Install Skill', '安装 Skill'), exact: true }).click(); await idle();
   assert.equal(sourceInstalled, true);
   console.log('central-management-browser: ' + locale + ' github-import passed');
   await page.locator('[data-central-tab=services]').click();
   const form = page.locator('[data-service-create]'), inspection = page.locator('[data-service-inspection]');
   await form.locator('[name=endpoint]').fill('https://docs.example/mcp'); await form.locator('[data-service-check]').click(); await idle();
   assert.match(await inspection.textContent(), locale === 'en' ? /Resources · Declared by the service/u : /资源 · 服务已声明/u);
   await form.locator('[name=endpoint]').fill('https://oauth.example/mcp'); assert.equal(await inspection.isVisible(), false);
   await form.locator('[data-service-check]').click(); await idle();
   assert.match(await inspection.textContent(), locale === 'en' ? /Select OAuth and connect/u : /请选择 OAuth 后连接/u);
   const registry = page.locator('[data-registry-import]');
   await registry.locator('summary').click();
   await registry.locator('[data-registry-file]').setInputFiles({ name: 'server.json', mimeType: 'application/json', buffer: Buffer.from('{"name":"example/mcp","version":"1.0.0"}') });
   await registry.locator('[data-registry-preview]').click(); await idle();
   assert.equal(requests.some(request => request.body?.action === 'connect'), false);
   await registry.getByRole('button', { name: copy('Use this connection', '使用此连接'), exact: true }).click(); await idle();
   assert.equal(await form.locator('[name=endpoint]').inputValue(), 'https://registry.example/mcp');
   assert.equal(await inspection.isVisible(), false);
   assert.equal(requests.some(request => request.body?.action === 'connect'), false);
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'New panels fit a mobile viewport');
   assert.deepEqual(errors, []);
   console.log('central-management-browser: ' + locale + ' inspection-registry passed');
  } finally { await page.close(); }
 }
 return { locales: 2, capacity_recovery: true, version_management: true, github_import: true, mcp_inspection: true, registry_form_fill: true };
}
