import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { adminDocument } from '../apps/worker/dist/admin/layout.js';
import { runnersPage } from '../apps/worker/dist/admin/runner-list-view.js';
import { adminRunnerError } from '../apps/worker/dist/http/responses.js';

/** Disposable HTTP fixtures exercise the shipped forms and bundle, without images. */
export async function checkRunnerActions(executable) {
  const requests = [], errors = [];
  let mode = 'fence', release, removed = false, runnerId = 'browser-runner';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('content-type', 'text/html');
      res.setHeader('cache-control', 'no-store');
      if (req.method === 'POST') {
        const parts = []; for await (const part of req) parts.push(part);
        const body = new URLSearchParams(Buffer.concat(parts).toString());
        requests.push(url.pathname);
        assert.equal(body.get('csrf_token'), 'fixture-csrf');
        assert.equal(body.get('confirmation'), runnerId);
        if (mode === 'delayed' || mode === 'delayed-success') await new Promise(resolve => { release = resolve; });
        if (mode === 'success' || mode === 'delayed-success' || mode === 'expired') {
          removed = mode !== 'expired'; res.statusCode = 303;
          res.setHeader('location', mode === 'expired' ? '/login' : '/admin/runners'); res.end(); return;
        }
        if (mode === 'unknown') { res.statusCode = 502; res.end('PRIVATE_UPSTREAM_DIAGNOSTIC'); return; }
        if (mode === 'stalled-headers') return;
        if (mode === 'stalled-body') { res.write('<!doctype html><html>'); return; }
        if (mode === 'network') {
          // Lose the response after headers arrive. An empty reused HTTP
          // socket can be retried by Chromium below the application layer.
          res.setHeader('content-length', '1024'); res.write('incomplete response');
          setImmediate(() => res.destroy()); return;
        }
        const response = adminRunnerError(503, 'Could not start deleting the Runner. Try again.');
        res.statusCode = response.status; res.end(await response.text()); return;
      }
      if (url.pathname === '/login') { res.end('<h1>Sign in</h1>'); return; }
      if (url.pathname === '/admin/clients') { res.end(adminDocument('Clients', '<section class="page-heading"><h1>Clients</h1></section>', 'clients')); return; }
      res.setHeader('set-cookie', 'fixture_console_session=active; Path=/; HttpOnly; SameSite=Lax');
      const data = { runners: removed ? [] : [{ runner_id: runnerId, display_name: 'Disposable Runner', state: 'offline', last_heartbeat_ms: null, public_info: null }] };
      res.end(adminDocument('Runners', runnersPage({ configuredModes: new Map([[runnerId, 'dedicated_user']]), maxValidityDays: 365 }, data, 'fixture-csrf'), 'runners'));
    } catch (error) { errors.push(String(error)); res.statusCode = 500; res.end('fixture failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
    const context = await browser.newContext();
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const openForm = async () => {
      await page.goto(origin + '/admin/runners');
      await page.getByText('More actions', { exact: true }).click();
      await page.locator('[name=confirmation]').fill(runnerId);
    };
    await openForm();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const notice = page.locator('[data-runner-action-feedback]');
    await notice.filter({ hasText: 'Could not start deleting' }).waitFor();
    assert.equal(page.url(), origin + '/admin/runners');
    assert.equal(await page.locator('[data-app-header]').count(), 1);
    assert.equal(await page.locator('.auth-body').count(), 0);
    assert.ok((await context.cookies()).some(cookie => cookie.name === 'fixture_console_session' && cookie.value === 'active'));
    assert.equal(requests.length, 1);
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-runner-danger-action]').hasAttribute('aria-busy'));
    assert.equal(requests.at(-1), '/admin/runners/browser-runner/revoke');

    mode = 'delayed'; const previous = requests.length;
    await page.evaluate(() => {
      const form = document.querySelector('[data-runner-danger-action]');
      const button = form.querySelector('button:not([formaction])');
      form.requestSubmit(button); form.requestSubmit(button);
    });
    await page.waitForFunction(() => document.querySelector('[data-runner-danger-action]').getAttribute('aria-busy') === 'true');
    const deadline = Date.now() + 10000;
    while (!release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(release, 'The delayed mutation must reach the server');
    assert.equal(requests.length, previous + 1); release();
    await page.waitForFunction(() => !document.querySelector('[data-runner-danger-action]').hasAttribute('aria-busy'));
    assert.equal(await page.getByRole('button', { name: 'Delete', exact: true }).isEnabled(), true);

    // A delayed success belongs to the departed page, even before its DOM is replaced.
    mode = 'delayed-success'; release = undefined; const beforeHandoff = requests.length;
    let releaseDestination, destinationStarted;
    const destinationReady = new Promise(resolve => { releaseDestination = resolve; });
    const destinationRequested = new Promise(resolve => { destinationStarted = resolve; });
    await page.route(origin + '/admin/clients', async route => { destinationStarted(); await destinationReady; await route.continue(); });
    try {
      const mutation = page.waitForRequest(request => request.method() === 'POST');
      await page.getByRole('button', { name: 'Delete', exact: true }).click(); await mutation;
      await page.locator('.control-nav a[href="/admin/clients"]').click(); await destinationRequested;
      assert.equal(await page.locator('[data-runner-danger-action]').count(), 1);
      const response = page.waitForResponse(result => result.url() === origin + '/admin/runners' && result.request().method() === 'GET');
      assert.ok(release); release(); await response;
      await page.waitForFunction(() => !document.querySelector('[data-runner-danger-action]')?.hasAttribute('aria-busy'));
      assert.equal(await page.locator('[data-runner-danger-action]').count(), 1, 'The old page must remain visible until the selected destination arrives');
      releaseDestination(); await page.waitForURL(origin + '/admin/clients');
      assert.equal(await page.getByRole('heading', { name: 'Clients', exact: true }).count(), 1);
      assert.equal(requests.length, beforeHandoff + 1, 'Leaving the page must not replay the Runner mutation');
    } finally { release?.(); releaseDestination(); await page.unroute(origin + '/admin/clients').catch(() => undefined); }
    removed = false; await openForm();

    mode = 'unknown';
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await notice.filter({ hasText: 'outcome could not be confirmed' }).waitFor();
    assert.equal(await page.getByText('PRIVATE_UPSTREAM_DIAGNOSTIC').count(), 0);
    assert.equal(page.url(), origin + '/admin/runners');

    mode = 'network'; const beforeLoss = requests.length;
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await notice.filter({ hasText: 'outcome could not be confirmed' }).waitFor();
    assert.equal(requests.length, beforeLoss + 1);
    assert.equal(page.url(), origin + '/admin/runners');

    await page.clock.install();
    for (const stalled of ['stalled-headers', 'stalled-body']) {
      mode = stalled; const beforeStall = requests.length;
      const response = stalled === 'stalled-body' ? page.waitForResponse(reply => reply.request().method() === 'POST') : undefined;
      await page.getByRole('button', { name: stalled === 'stalled-body' ? 'Revoke' : 'Delete', exact: true }).click();
      const deadline = Date.now() + 10000;
      while (requests.length === beforeStall && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(requests.length, beforeStall + 1, 'The stalled request must reach the server exactly once');
      if (response) await response;
      await page.clock.fastForward(25001);
      await notice.filter({ hasText: 'outcome could not be confirmed' }).waitFor({ timeout: 2000 });
      await page.waitForFunction(() => !document.querySelector('[data-runner-danger-action]').hasAttribute('aria-busy'), null, { timeout: 2000 });
      assert.equal(await page.getByRole('button', { name: 'Delete', exact: true }).isEnabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Revoke', exact: true }).isEnabled(), true);
      assert.equal(requests.length, beforeStall + 1, 'Timing out must not replay a destructive request');
      assert.equal(page.url(), origin + '/admin/runners');
      assert.equal(await page.locator('[data-app-header]').count(), 1);
      assert.ok((await context.cookies()).some(cookie => cookie.name === 'fixture_console_session' && cookie.value === 'active'));
    }

    mode = 'success';
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByText('No runners yet.', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-app-header]').count(), 1);
    removed = false; runnerId = 'browser:runner'; mode = 'fence'; await openForm();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await notice.filter({ hasText: 'Could not start deleting' }).waitFor();
    assert.equal(requests.at(-1), '/admin/runners/browser%3Arunner/delete');
    removed = false; mode = 'expired'; await openForm();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    assert.equal(page.url(), origin + '/login');
    assert.deepEqual(errors, []);
    return { state: 'passed', inline_errors: true, session_preserved: true, submitter_respected: true, duplicate_post_blocked: true, stale_success_keeps_destination: true, unknown_not_replayed: true, stalled_headers_recover: true, stalled_body_recovers: true, successful_delete_refresh: true, expired_session_redirect: true, screenshots: 0 };
  } finally { release?.(); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
