import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { adminDocument } from '../apps/worker/dist/admin/layout.js';

/** Exercise the shipped navigation bundle using disposable HTTP responses. */
export async function checkAdminNavigation(executable) {
  const requests = [], errors = [];
  let phase, arrived, release;
  const pageFor = path => adminDocument('Navigation fixture', '<p data-navigation-fixture>' + path + '</p>'
    + (path === '/admin/clients' ? '<div style="height:1800px"></div><section id="add-client"><h2>Add a client</h2></section><div style="height:1000px"></div>' : '')
    + (path === '/admin/settings' ? '<a href="/admin/clients#add-client" data-fragment-link>Add a client</a>' : ''), 'dashboard');
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    const navigation = req.headers['sec-fetch-mode'] === 'navigate';
    requests.push({ path, navigation });
    res.setHeader('content-type', 'text/html');
    res.setHeader('cache-control', 'no-store');
    if (path === '/admin/runners' && !navigation) {
      arrived?.();
      if (phase === 'headers') return;
      if (phase === 'body') { res.write('<!doctype html><html>'); return; }
      release = () => {
        if (phase === 'network') { res.statusCode = 503; res.end('Temporarily unavailable'); }
        else res.end(pageFor(path).replace('<html lang="en">', '<html lang="zh-CN">'));
      };
      return;
    }
    res.end(pageFor(path));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const scenarios = [['headers', false], ['body', false], ['headers', true], ['body', true], ['network', true], ['locale', true]];
  try {
    browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
    for (const [mode, queued] of scenarios) {
      phase = mode; release = undefined; requests.length = 0;
      const page = await browser.newPage();
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(origin + '/admin');
        await page.waitForFunction(() => document.documentElement.getAttribute('data-runmesh-navigation') === 'ready');
        await page.evaluate(() => { window.navigationFixtureVisited = true; });
        await page.clock.install();
        const requested = new Promise(resolve => { arrived = resolve; });
        const headers = mode === 'body' ? page.waitForResponse(response => response.url() === origin + '/admin/runners') : undefined;
        await page.locator('nav a[href="/admin/runners"]').click();
        await requested;
        if (headers) await headers;
        if (queued) await page.locator('nav a[href="/admin/clients"]').click();
        const destination = queued ? '/admin/clients' : '/admin/runners';
        const loaded = page.waitForURL(origin + destination, { timeout: 5000 });
        if (release) release();
        else await page.clock.fastForward(25001);
        await loaded;
        await page.locator('[data-navigation-fixture]').filter({ hasText: destination }).waitFor();
        await page.waitForFunction(() => document.documentElement.getAttribute('data-runmesh-navigation') === 'ready');
        assert.equal(await page.evaluate(() => window.navigationFixtureVisited), undefined, 'Fallback must perform one full page load');
        assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-runmesh-navigation-busy') === 'true'), false);
        assert.deepEqual(requests.filter(request => !request.navigation && request.path.startsWith('/admin')), [{ path: '/admin/runners', navigation: false }]);
        assert.deepEqual(requests.filter(request => request.navigation).map(request => request.path), ['/admin', destination]);
      } finally { arrived = undefined; release = undefined; await page.close(); }
    }
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(origin + '/admin/clients');
      await page.waitForFunction(() => document.documentElement.getAttribute('data-runmesh-navigation') === 'ready');
      await page.locator('#add-client').scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => scrollY > 500), 'The starting page is scrolled well below the fold');
      await page.locator('nav a[href="/admin/settings"]').click();
      await page.waitForURL(origin + '/admin/settings');
      await page.waitForFunction(() => document.documentElement.getAttribute('data-runmesh-navigation-busy') === 'false');
      assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'A short page must shrink to its content instead of inheriting the previous tall page');
      assert.ok(await page.locator('#main-content').evaluate(node => node.getBoundingClientRect().top >= document.querySelector('.app-header').getBoundingClientRect().bottom - 1), 'A new page heading remains below the sticky header');
      await page.locator('[data-fragment-link]').click();
      await page.waitForURL(origin + '/admin/clients#add-client');
      await page.waitForFunction(() => document.documentElement.getAttribute('data-runmesh-navigation-busy') === 'false');
      assert.deepEqual(await page.locator('#add-client').evaluate(node => {
        const gap = node.getBoundingClientRect().top - document.querySelector('.app-header').getBoundingClientRect().bottom;
        return { focused: document.activeElement === node, visibleBelowHeader: gap >= 0 && gap <= 32 };
      }), { focused: true, visibleBelowHeader: true }, 'Fragment navigation must focus the requested section and place it below the current header');
    } finally { await page.close(); }
    assert.deepEqual(errors, []);
    return { state: 'passed', scenarios: scenarios.length + 2, stalled_headers_recover: true, stalled_body_recovers: true, latest_destination_preserved: true, short_page_height_restored: true, fragment_focus_and_scroll_restored: true, screenshots: 0 };
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
