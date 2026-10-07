import assert from 'node:assert/strict';
import { createProductFixture } from './product-browser-fixture.mjs';

const profile = id => ({ profile_id: id, connector_id: id, display_name: id, endpoint: 'https://' + id + '.example/mcp',
  authentication: 'oauth', enabled: true, revision: 1, credential: null });
const catalog = id => ({ state: 'found', head: { profile_id: id, revision: 1, approved_digest: 'a'.repeat(64), approved_names: [] },
  snapshot: { digest: 'a'.repeat(64), tools: [] }, changes: [] });
function gate() {
  let resolve, timer;
  const promise = new Promise((done, reject) => {
    timer = setTimeout(() => reject(new Error('OAuth fixture response was not released')), 20000);
    resolve = () => { clearTimeout(timer); done(); };
  });
  return { promise, resolve };
}
async function observed(read, label) {
  const deadline = Date.now() + 10000;
  while (!read() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const value = read(); assert.ok(value, label); return value;
}

/** Full-page OAuth ownership is shared by new connections and existing MCPs. */
export async function checkOAuthHandoffs(browser) {
  const scenarios = [
    { first: 'a', second: 'b', newerFirst: false },
    { first: 'a', second: 'b', newerFirst: true },
    { first: 'a', second: 'create', newerFirst: false },
    { first: 'create', second: 'b', newerFirst: false },
    { first: 'create', second: 'b', newerFirst: true },
    { first: 'a', second: 'b', failLatest: true },
    { first: 'a', second: 'b', failLatest: true, failOlder: true },
  ];
  for (const scenario of scenarios) {
    const fixture = await createProductFixture(), page = await browser.newPage(), begins = [], choices = [], errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    const card = id => page.locator('[data-service-list] article[data-operation-scope="mcp:' + id + '"]');
    const ready = id => page.waitForFunction(id => [...document.querySelectorAll('[data-service-list] article')]
      .find(node => node.getAttribute('data-operation-scope') === 'mcp:' + id)?.querySelector('button')?.disabled === false, id);
    try {
      fixture.profiles.push(profile('a'), profile('b'));
      for (const id of ['a', 'b']) fixture.catalogs.set(id, catalog(id));
      await page.route('**/admin/central/connections/begin', async route => {
        const request = { id: route.request().postDataJSON().profile_id, gate: gate(), failure: false };
        begins.push(request); await request.gate.promise;
        const value = request.failure ? { error: { code: 'oauth_configuration_required', operation_state: 'not_started' } }
          : { state: 'started', profile_id: request.id, authorization_url: fixture.origin + '/oauth-choice?profile=' + request.id };
        // A completed full navigation can abort the other page's held request.
        await route.fulfill({ status: request.failure ? 503 : 200, contentType: 'application/json', body: JSON.stringify(value) }).catch(() => undefined);
      });
      await page.route('**/oauth-choice?*', route => {
        choices.push(new URL(route.request().url()).searchParams.get('profile'));
        return route.fulfill({ contentType: 'text/html', body: '<main>OAuth fixture</main>' });
      });
      await page.goto(fixture.origin + '/admin/central'); await page.waitForLoadState('networkidle');
      async function act(kind) {
        const count = begins.length;
        if (kind === 'create') {
          const form = page.locator('[data-service-create]');
          await form.locator('[name=endpoint]').fill('https://created.example/mcp');
          await form.locator('[name=name]').fill('Created');
          await form.locator('[name=authentication]').selectOption('oauth');
          await form.locator('[type=submit]').click();
        } else await card(kind).getByRole('button', { name: 'Reconnect', exact: true }).click();
        return observed(() => begins[count], kind + ' must reach its intercepted OAuth begin');
      }
      const first = await act(scenario.first), second = await act(scenario.second);
      if (scenario.failLatest) {
        second.failure = true; second.gate.resolve(); await ready(second.id);
        const feedback = await page.locator('[data-product-status]').textContent();
        assert.match(feedback, /OAuth settings/u);
        first.failure = !!scenario.failOlder; first.gate.resolve(); await ready(first.id);
        assert.equal(await page.locator('[data-product-status]').textContent(), feedback, 'Older success or failure cannot replace the latest failure');
        assert.equal(page.url(), fixture.origin + '/admin/central'); assert.deepEqual(choices, []);
        const retry = await act(scenario.second); retry.gate.resolve();
        await page.waitForURL(fixture.origin + '/oauth-choice?profile=' + retry.id);
      } else if (scenario.newerFirst) {
        second.gate.resolve(); await page.waitForURL(fixture.origin + '/oauth-choice?profile=' + second.id);
        first.gate.resolve();
      } else {
        first.gate.resolve(); await ready(first.id);
        assert.equal(page.url(), fixture.origin + '/admin/central', 'The superseded response must leave the current page in place');
        assert.deepEqual(choices, []);
        second.gate.resolve(); await page.waitForURL(fixture.origin + '/oauth-choice?profile=' + second.id);
      }
      assert.deepEqual(choices, [second.id], 'Only the most recent OAuth intent may choose a provider');
      assert.deepEqual(errors, []); assert.deepEqual(fixture.exceptions, []);
    } finally {
      for (const request of begins) request.gate.resolve();
      await page.close(); await fixture.close();
    }
  }
  return { scenarios: scenarios.length, latest_oauth_intent: true, creation_handoff: true, failure_does_not_revive_older: true };
}
