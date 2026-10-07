import assert from 'node:assert/strict';
import { createProductFixture } from './product-browser-fixture.mjs';
import { checkOAuthHandoffs } from './central-oauth-browser-check.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const profile = (id, authentication = 'none') => ({ profile_id: id, connector_id: id, display_name: id,
  endpoint: 'https://' + id + '.example/mcp', revision: 1, enabled: true, credential: null, authentication });

/** Actual product controls, held upstream responses, no external providers or screenshots. */
export async function checkCentralRecovery(browser) {
  const fixture = await createProductFixture(), page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const waits = new Map(), observed = new Map(), started = [], responses = new Map();
  const card = id => page.locator('[data-service-list] article').filter({ has: page.getByRole('heading', { name: id, exact: true }) });
  try {
    fixture.profiles.push(profile('slow-a'), profile('pending-b'), profile('slow-c'));
    for (const id of ['slow-a', 'slow-c']) { waits.set(id, gate()); observed.set(id, gate()); }
    await page.route('**/admin/central/discovery/*', async route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      started.push(id);
      observed.get(id)?.resolve();
      if (waits.has(id)) await waits.get(id).promise;
      if (responses.has(id)) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(responses.get(id)) });
      else await route.continue();
    });
    const aStarted = page.waitForRequest(request => request.url().endsWith('/discovery/slow-a'));
    await page.goto(fixture.origin + '/admin/central'); await aStarted;
    assert.equal(await card('slow-a').getByRole('button', { name: 'Pause', exact: true }).isDisabled(), true);
    assert.equal(await card('pending-b').getByRole('button', { name: 'Pause', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('[data-central-tab=skills]').isEnabled(), true);
    assert.equal(await page.locator('[data-service-create] [type=submit]').isEnabled(), true);
    assert.equal(await page.locator('[data-product-refresh]').isEnabled(), true);
    // Forced DOM events prove admission, in addition to disabled presentation.
    await card('slow-a').getByRole('button', { name: 'Refresh tools', exact: true }).dispatchEvent('click');
    await card('slow-a').getByRole('button', { name: 'Pause', exact: true }).dispatchEvent('click');
    await page.locator('[data-product-refresh]').click();
    await page.locator('[data-central-product][aria-busy=false]').waitFor();
    assert.equal(await card('slow-a').getByRole('button', { name: 'Pause', exact: true }).isDisabled(), true,
      'Refreshing lists preserves the in-flight connection lock on recreated controls');
    await card('pending-b').getByRole('button', { name: 'Pause', exact: true }).click();
    await card('pending-b').getByRole('button', { name: 'Enable', exact: true }).waitFor();
    await page.locator('[data-central-tab=skills]').click();
    const importer = page.locator('[data-skill-import]');
    await importer.locator('[name=files]').setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown',
      buffer: Buffer.from('---\nname: independent-skill\ndescription: Independent workflow\n---\nReview the project.') });
    await importer.getByRole('button', { name: 'Install Skill', exact: true }).click();
    await page.locator('[data-product-status]').filter({ hasText: 'independent-skill installed.' }).waitFor();
    await page.locator('[data-skill-list]').getByRole('button', { name: 'View files', exact: true }).click();
    const review = page.locator('[data-skill-review]');
    await review.getByRole('heading', { name: 'independent-skill', exact: true }).waitFor();
    const skillStatus = await page.locator('[data-product-status]').textContent();
    responses.set('slow-a', { error: { code: 'central_unavailable', operation_state: 'unknown' } });
    const cStarted = page.waitForRequest(request => request.url().endsWith('/discovery/slow-c'));
    waits.get('slow-a').resolve(); await cStarted; await observed.get('slow-c').promise;
    assert.deepEqual(started, ['slow-a', 'slow-c'], 'A paused pending connection is skipped and conflicting clicks are never replayed');
    assert.equal(fixture.requests.filter(request => request.path === '/admin/central/profiles/slow-a').length, 0);
    assert.equal(await review.isVisible(), true, 'Background MCP completion preserves the independent Skill review');
    assert.equal(await review.getByRole('heading', { name: 'independent-skill', exact: true }).count(), 1);
    assert.equal(await page.locator('[data-product-status]').textContent(), skillStatus);
    await page.locator('[data-central-tab=services]').click();
    assert.equal(await card('slow-a').getByRole('button', { name: 'Pause', exact: true }).isEnabled(), true);
    assert.equal(await card('slow-c').getByRole('button', { name: 'Pause', exact: true }).isDisabled(), true);
    const beforeNavigation = fixture.requests.length;
    await page.locator('nav a[href="/admin"]').click();
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor();
    waits.get('slow-c').resolve();
    await page.waitForLoadState('networkidle');
    assert.equal(fixture.requests.slice(beforeNavigation).some(request => /\/(profiles|catalogs)\b/u.test(request.path)), false,
      'A late discovery response does not read or render into the next page');
    assert.equal(await page.locator('[data-central-product]').count(), 0);

    // A form draft also takes presentation ownership, without needing a submitted action.
    fixture.profiles.splice(0, fixture.profiles.length, profile('draft-only'));
    waits.clear(); const draftWait = gate(); waits.set('draft-only', draftWait);
    const draftStarted = page.waitForRequest(request => request.url().endsWith('/discovery/draft-only'));
    await page.goto(fixture.origin + '/admin/central'); await draftStarted;
    const draft = page.locator('[data-service-create] [name=name]');
    await draft.fill('Connection draft');
    const draftStatus = await page.locator('[data-product-status]').textContent();
    draftWait.resolve();
    await card('draft-only').locator('[data-service-status]').filter({ hasText: 'Connected.' }).waitFor();
    assert.equal(await draft.inputValue(), 'Connection draft');
    assert.equal(await page.locator('[data-service-tools]').isHidden(), true, 'Recovery does not open or scroll a panel over a form draft');
    assert.equal(await page.locator('[data-product-status]').textContent(), draftStatus);

    // A failed reconciliation continues to block writes to the MCP collection, not Skill work.
    fixture.profiles.splice(0, fixture.profiles.length, profile('uncertain'));
    waits.clear(); responses.set('uncertain', { error: { code: 'central_unavailable', operation_state: 'unknown' } });
    const uncertainWait = gate(); waits.set('uncertain', uncertainWait);
    const uncertainStarted = page.waitForRequest(request => request.url().endsWith('/discovery/uncertain'));
    await page.goto(fixture.origin + '/admin/central'); await uncertainStarted;
    fixture.controls.library.unavailable = true; uncertainWait.resolve();
    await card('uncertain').locator('[data-service-status][data-error=true]').waitFor();
    await card('uncertain').getByRole('button', { name: 'Refresh tools', exact: true }).click();
    await page.locator('[data-product-status]').filter({ hasText: 'Refresh before making another change.' }).waitFor();
    assert.equal(started.filter(id => id === 'uncertain').length, 1, 'A failed reconciliation cannot replay discovery');
    await page.locator('[data-central-tab=skills]').click();
    await page.locator('[data-skill-list]').getByRole('button', { name: 'Pause', exact: true }).click();
    await page.locator('[data-skill-list]').getByText('Paused', { exact: true }).waitFor();
    fixture.controls.library.unavailable = false;
    await page.locator('[data-product-refresh]').click();
    await page.locator('[data-central-product][aria-busy=false]').waitFor();
    responses.delete('uncertain');
    await page.locator('[data-central-tab=services]').click();
    await card('uncertain').getByRole('button', { name: 'Refresh tools', exact: true }).click();
    await page.locator('[data-product-status]').filter({ hasText: 'Connected.' }).waitFor();
    assert.equal(started.filter(id => id === 'uncertain').length, 2);

    // Authorization completes once, then the background pass publishes the returned connection.
    const form = page.locator('[data-service-create]');
    await form.locator('[name=name]').fill('oauth-return');
    await form.locator('[name=endpoint]').fill('https://oauth-return.example/mcp');
    await form.locator('[name=authentication]').selectOption('oauth');
    const beforeOAuth = fixture.requests.length;
    await form.locator('[type=submit]').click();
    await card('oauth-return').locator('[data-service-status]').filter({ hasText: 'Connected.' }).waitFor();
    await page.waitForLoadState('networkidle');
    const flow = fixture.requests.slice(beforeOAuth);
    for (const route of ['begin', 'complete']) assert.equal(flow.filter(request => request.path === '/admin/central/connections/' + route).length, 1);
    const linked = fixture.profiles.find(item => item.display_name === 'oauth-return');
    assert.equal(flow.filter(request => request.path === '/admin/central/discovery/' + linked.profile_id).length, 1);
    assert.equal(fixture.catalogs.has(linked.profile_id), true);
    assert.equal(new URL(page.url()).search, '');
    assert.equal(await card('oauth-return').getByRole('button', { name: 'Reconnect', exact: true }).isEnabled(), true);
    assert.deepEqual(errors, []); assert.deepEqual(fixture.exceptions, []);
    await checkServicePanelOwnership(browser);
    await checkOAuthHandoffs(browser);
    return { independent_skill_and_mcp_operations: true, same_connection_serialized: true, stale_result_ignored: true,
      uncertain_write_reconciled: true, form_draft_preserved: true, oauth_callback_once: true,
      scoped_panel_invalidation: true, latest_tool_selection_preserved: true, latest_oauth_handoff_preserved: true, screenshots: 0 };
  } finally {
    for (const wait of waits.values()) wait.resolve();
    await page.close(); await fixture.close();
  }
}

async function checkServicePanelOwnership(browser) {
  const catalog = id => ({ state: 'found', head: { profile_id: id, revision: 1, approved_digest: 'a'.repeat(64), approved_names: [] },
    snapshot: { digest: 'a'.repeat(64), tools: [] }, changes: [] });
  const inspected = endpoint => ({ state: 'inspected', endpoint, server: { protocol_version: '2025-11-25',
    capabilities: { tools: true, resources: false, prompts: false, tasks: false, apps: false } }, tools_count: 1, observed_at_ms: 1000 });
  const registryPreview = { state: 'previewed', name: 'example/mcp', version: '1.0.0', description: 'Team service', schema: null,
    digest: 'a'.repeat(64), observed_at_ms: 1000, remotes: [{ endpoint: 'https://registry.example/mcp', transport: 'streamable-http', mode: 'connect', headers: [] }], packages: [] };
  for (const kind of ['tools', 'inspection-profile', 'inspection-form', 'registry']) {
    const fixture = await createProductFixture(), page = await browser.newPage(), pending = gate(), entered = gate(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      fixture.profiles.push(profile('panel-a'), profile('panel-b')); fixture.catalogs.set('panel-b', catalog('panel-b'));
      await page.route('**/admin/central/discovery/panel-a', async route => {
        entered.resolve(); await pending.promise;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'central_unavailable', operation_state: 'unknown' } }) });
      });
      await page.route('**/admin/central/connection-check', route => route.fulfill({ contentType: 'application/json',
        body: JSON.stringify(inspected(route.request().postDataJSON().endpoint ?? 'https://panel-b.example/mcp')) }));
      await page.route('**/admin/central/registry-preview', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(registryPreview) }));
      await page.goto(fixture.origin + '/admin/central'); await entered.promise;
      const b = page.locator('[data-service-list] article').filter({ has: page.getByRole('heading', { name: 'panel-b', exact: true }) });
      let panel;
      if (kind === 'tools') {
        await b.getByRole('button', { name: 'View tools', exact: true }).click(); panel = page.locator('[data-service-tools]');
      } else if (kind.startsWith('inspection')) {
        if (kind === 'inspection-profile') await b.getByRole('button', { name: 'Check connection', exact: true }).click();
        else {
          await page.locator('[data-service-create] [name=endpoint]').fill('https://draft.example/mcp');
          await page.locator('[data-service-check]').click();
        }
        panel = page.locator('[data-service-inspection]');
      } else {
        const registry = page.locator('[data-registry-import]');
        await registry.locator('summary').click();
        await registry.locator('[data-registry-file]').setInputFiles({ name: 'server.json', mimeType: 'application/json',
          buffer: Buffer.from('{"name":"example/mcp","version":"1.0.0"}') });
        await registry.locator('[data-registry-preview]').click(); panel = registry.locator('[data-registry-results]');
      }
      await panel.getByRole('heading').waitFor(); const content = await panel.textContent();
      pending.resolve();
      await page.locator('[data-service-status="panel-a"][data-error=true]').waitFor();
      await page.waitForLoadState('networkidle');
      assert.equal(await panel.textContent(), content, kind + ': an unrelated unknown write preserves the selected panel');
      assert.equal(await panel.isVisible(), true);
      assert.deepEqual(errors, []); assert.deepEqual(fixture.exceptions, []);
    } finally { pending.resolve(); await page.close(); await fixture.close(); }
  }
  for (const action of ['View tools', 'Refresh tools']) {
    const fixture = await createProductFixture(), page = await browser.newPage(), pending = gate(), entered = gate(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      fixture.profiles.push(profile('selection-a'), profile('selection-b'));
      for (const id of ['selection-a', 'selection-b']) fixture.catalogs.set(id, catalog(id));
      await page.goto(fixture.origin + '/admin/central'); await page.waitForLoadState('networkidle');
      const endpoint = action === 'View tools' ? 'catalogs' : 'discovery';
      await page.route('**/admin/central/' + endpoint + '/selection-a', async route => {
        entered.resolve(); await pending.promise; await route.continue();
      });
      const card = id => page.locator('[data-service-list] article').filter({ has: page.getByRole('heading', { name: id, exact: true }) });
      await card('selection-a').getByRole('button', { name: action, exact: true }).click(); await entered.promise;
      await card('selection-b').getByRole('button', { name: 'View tools', exact: true }).click();
      const panel = page.locator('[data-service-tools]');
      await panel.getByRole('heading', { name: 'selection-b', exact: true }).waitFor();
      pending.resolve();
      // A held route may outlive an already-reached networkidle state. Wait for
      // the scoped operation to finish before checking its final presentation.
      await page.waitForFunction(label => [...document.querySelectorAll('[data-operation-scope="mcp:selection-a"] button')]
        .some(button => button.textContent === label && !button.disabled), action);
      assert.equal(await panel.locator('h2').textContent(), 'selection-b', action + ': an older intent cannot replace the later selection');
      assert.equal(await card('selection-a').getByRole('button', { name: action, exact: true }).isEnabled(), true);
      assert.deepEqual(errors, []); assert.deepEqual(fixture.exceptions, []);
    } finally { pending.resolve(); await page.close(); await fixture.close(); }
  }
}
