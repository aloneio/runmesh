import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { adminDocument } from '../apps/worker/dist/admin/layout.js';
import { runnersPage } from '../apps/worker/dist/admin/runner-list-view.js';
import { oauthLanding } from '../apps/worker/dist/http/oauth-landing.js';
import { ADMIN_CSRF_COOKIE } from '../apps/worker/dist/http/constants.js';
import { createProductFixture } from './product-browser-fixture.mjs';

function gate() {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  return { pending, entered, release, started };
}

function unexpectedNavigation(page, url) {
  return page.waitForRequest(request => request.isNavigationRequest() && request.url() === url, { timeout: 1500 })
    .then(() => true, error => { if (error.name === 'TimeoutError') return false; throw error; });
}

async function checkNativeHandoffs(browser) {
  const gates = { revoke: gate(), rename: gate(), complete: gate(), clients: gate() }, posts = [], errors = [];
  let callbackBodyPending = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('content-type', 'text/html'); res.setHeader('cache-control', 'no-store');
      res.setHeader('set-cookie', ADMIN_CSRF_COOKIE + '=fixture-csrf; Path=/; SameSite=Strict; Secure');
      if (req.method === 'POST') {
        for await (const _ of req) { /* Drain the browser-owned submission. */ }
        posts.push(url.pathname);
        const action = url.pathname.split('/').at(-1);
        const current = gates[action];
        assert.ok(current);
        if (action === 'complete' && callbackBodyPending) { res.setHeader('content-type', 'application/json'); res.write('{"state":"linked",'); }
        current.started(); await current.pending;
        if (action === 'revoke') { res.statusCode = 303; res.setHeader('location', '/admin/runners?result=revoked'); res.end(); return; }
        if (action === 'rename') { res.end('<h1>Rename receipt</h1>'); return; }
        if (callbackBodyPending) res.end('"profile_id":"handoff-account"}');
        else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ state: 'linked', profile_id: 'handoff-account' })); }
        return;
      }
      if (url.pathname.endsWith('/callback')) {
        const response = oauthLanding(); for (const [key, value] of response.headers) res.setHeader(key, value);
        res.end(await response.text()); return;
      }
      if (url.pathname === '/admin/clients') { gates.clients.started(); await gates.clients.pending; res.end('<h1>Chosen clients page</h1>'); return; }
      if (url.pathname === '/admin/central') { res.end('<h1>Late callback destination</h1>'); return; }
      const data = { runners: [{ runner_id: 'handoff-runner', display_name: 'Handoff Runner', state: 'offline', last_heartbeat_ms: null, public_info: null }] };
      res.end(adminDocument('Runners', runnersPage({ configuredModes: new Map([['handoff-runner', 'dedicated_user']]), maxValidityDays: 365 }, data, 'fixture-csrf'), 'runners'));
    } catch (error) { errors.push(String(error)); res.statusCode = 500; res.end('fixture failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const context = await browser.newContext(), page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin + '/admin/runners');
    await page.getByText('More actions', { exact: true }).click();
    await page.locator('[name=confirmation]').fill('handoff-runner');
    await page.getByRole('button', { name: 'Revoke', exact: true }).click(); await gates.revoke.entered;
    await page.getByRole('button', { name: 'Rename', exact: true }).click({ noWaitAfter: true }); await gates.rename.entered;
    const lateRunner = unexpectedNavigation(page, origin + '/admin/runners?result=revoked');
    gates.revoke.release(); const runnerRedirected = await lateRunner; gates.rename.release();
    assert.equal(runnerRedirected, false, 'A late Runner result must preserve the native form response');
    await page.waitForURL(origin + '/admin/runners/handoff-runner/rename');
    await page.getByRole('heading', { name: 'Rename receipt', exact: true }).waitFor();

    for (const bodyPending of [false, true]) {
      callbackBodyPending = bodyPending; gates.complete = gate(); gates.clients = gate();
      const headers = bodyPending ? page.waitForResponse(response => response.url().endsWith('/connections/complete')) : undefined;
      await page.goto(origin + '/admin/central/connections/callback?state=fixture&code=fixture'); await gates.complete.entered;
      if (headers) await headers;
      await page.locator('.control-nav a[href="/admin/clients"]').click({ noWaitAfter: true }); await gates.clients.entered;
      const lateCallback = unexpectedNavigation(page, origin + '/admin/central?connected=handoff-account');
      gates.complete.release(); const callbackRedirected = await lateCallback; gates.clients.release();
      assert.equal(callbackRedirected, false, 'Late OAuth ' + (bodyPending ? 'body' : 'headers') + ' must preserve the selected page');
      await page.waitForURL(origin + '/admin/clients');
      await page.getByRole('heading', { name: 'Chosen clients page', exact: true }).waitFor();
    }
    assert.deepEqual(posts, ['/admin/runners/handoff-runner/revoke', '/admin/runners/handoff-runner/rename', '/admin/central/connections/complete', '/admin/central/connections/complete']);
    assert.deepEqual(errors, []);
  } finally { for (const current of Object.values(gates)) current.release(); await context.close(); await new Promise(resolve => server.close(resolve)); }
}

async function checkLocaleHandoff(browser) {
  const fixture = await createProductFixture();
  const { origin, profiles, catalogs, controls, digest } = fixture;
  profiles.push({ profile_id: 'handoff-oauth', connector_id: 'handoff-oauth', display_name: 'Handoff MCP', endpoint: 'https://provider.example/mcp', revision: 1, enabled: true, credential: null, authentication: 'oauth' });
  catalogs.set('handoff-oauth', { state: 'found', head: { profile_id: 'handoff-oauth', revision: 1, observed_digest: digest, approved_digest: digest, approved_names: [] }, snapshot: { digest, tools: [] }, changes: [] });
  const oauth = gate(), destination = gate(), context = await browser.newContext(), page = await context.newPage();
  controls.oauth.delayed = oauth.pending;
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route(origin + '/admin/central?lang=zh-CN', async route => { destination.started(); await destination.pending; await route.continue().catch(() => undefined); });
    await page.goto(origin + '/admin/central');
    await page.locator('[data-central-product][aria-busy="false"]').waitFor();
    const begin = page.waitForRequest(request => request.url().endsWith('/connections/begin'));
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click(); await begin;
    await page.locator('[data-lang-toggle="zh-CN"]').click({ noWaitAfter: true }); await destination.entered;
    const lateOAuth = unexpectedNavigation(page, origin + '/late-oauth-fixture');
    oauth.release(); const redirected = await lateOAuth; destination.release();
    assert.equal(redirected, false, 'A late OAuth handoff must preserve the selected language');
    await page.waitForURL(origin + '/admin/central?lang=zh-CN');
    await page.locator('[data-central-product][aria-busy="false"]').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
    assert.equal(fixture.requests.filter(request => request.path.endsWith('/connections/begin')).length, 1);
    assert.deepEqual(errors, []); assert.deepEqual(fixture.exceptions, []);
  } finally { oauth.release(); destination.release(); await context.close(); await fixture.close(); }
}

/** Real native navigations retain their chosen destination while older requests finish. */
export async function checkNavigationHandoffs(executable) {
  const browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
  try {
    await checkNativeHandoffs(browser);
    await checkLocaleHandoff(browser);
    return { state: 'passed', native_form_preserved: true, callback_destination_preserved: true, language_destination_preserved: true, mutations_not_replayed: true, screenshots: 0 };
  } finally { await browser.close(); }
}
