import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { adminDocument } from '../apps/worker/dist/admin/layout.js';
import { runnersPage } from '../apps/worker/dist/admin/runner-list-view.js';
import { adminRunnerError } from '../apps/worker/dist/http/responses.js';

/** Disposable HTTP fixtures exercise the shipped forms and bundle, without images. */
export async function checkRunnerActions(executable) {
  const requests = [], errors = [];
  let mode = 'fence', release, removed = false;
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
        assert.equal(body.get('confirmation'), 'browser-runner');
        if (mode === 'delayed') await new Promise(resolve => { release = resolve; });
        if (mode === 'success' || mode === 'expired') {
          removed = mode === 'success'; res.statusCode = 303;
          res.setHeader('location', mode === 'expired' ? '/login' : '/admin/runners'); res.end(); return;
        }
        if (mode === 'unknown') { res.statusCode = 502; res.end('PRIVATE_UPSTREAM_DIAGNOSTIC'); return; }
        if (mode === 'network') {
          // Lose the response after headers arrive. An empty reused HTTP
          // socket can be retried by Chromium below the application layer.
          res.setHeader('content-length', '1024'); res.write('incomplete response');
          setImmediate(() => res.destroy()); return;
        }
        const response = adminRunnerError(503, 'Runner deletion could not fence the Runner.');
        res.statusCode = response.status; res.end(await response.text()); return;
      }
      if (url.pathname === '/login') { res.end('<h1>Sign in</h1>'); return; }
      res.setHeader('set-cookie', 'fixture_console_session=active; Path=/; HttpOnly; SameSite=Lax');
      const data = { runners: removed ? [] : [{ runner_id: 'browser-runner', display_name: 'Disposable Runner', state: 'offline', last_heartbeat_ms: null, public_info: null }] };
      res.end(adminDocument('Runners', runnersPage({ configuredModes: new Map([['browser-runner', 'dedicated_user']]), maxValidityDays: 365 }, data, 'fixture-csrf'), 'runners'));
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
      await page.locator('[name=confirmation]').fill('browser-runner');
    };
    await openForm();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const notice = page.locator('[data-runner-action-feedback]');
    await notice.filter({ hasText: 'could not fence' }).waitFor();
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

    mode = 'success';
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByText('No runners yet.', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-app-header]').count(), 1);
    removed = false; mode = 'expired'; await openForm();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    assert.equal(page.url(), origin + '/login');
    assert.deepEqual(errors, []);
    return { state: 'passed', inline_errors: true, session_preserved: true, submitter_respected: true, duplicate_post_blocked: true, unknown_not_replayed: true, successful_delete_refresh: true, expired_session_redirect: true, screenshots: 0 };
  } finally { release?.(); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
