import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { adminDocument } from '../apps/worker/dist/admin/layout.js';
import { authEntryDocument, secretCreatedPage } from '../apps/worker/dist/admin/auth-views.js';
import { overviewPage, settingsPage } from '../apps/worker/dist/admin/dashboard-views.js';
import { clientsPage, clientDetailPage } from '../apps/worker/dist/admin/client-views.js';
import { runnersPage } from '../apps/worker/dist/admin/runner-list-view.js';
import { runnerDetailPage } from '../apps/worker/dist/admin/runner-detail-view.js';
import { centralPage } from '../apps/worker/dist/admin/central-view.js';
import { enrollmentDocument } from '../apps/worker/dist/admin/enrollment-view.js';
import { localizeUiText } from '../apps/worker/dist/i18n/legacy-text.js';

// Reuse public render fixtures; measurements exercise the shipped CSS and browser bundle.
const views = { authEntryDocument, secretCreatedPage, overviewPage, settingsPage, clientsPage, clientDetailPage, runnersPage, runnerDetailPage };
const viewports = [320, 390, 768, 800, 801, 900, 1024, 1050, 1051, 1064, 1365, 1440, 1787];
async function fixtureDocuments() {
  const { cases } = JSON.parse(await readFile(new URL('../apps/worker/test/fixtures/admin-render-golden.json', import.meta.url), 'utf8'));
  const documents = new Map();
  for (const fixture of cases.filter(f => !f.name.endsWith('-empty') && f.fn !== 'adminDocument')) {
    const args = structuredClone(fixture.args);
    if (fixture.fn === 'runnersPage') args.unshift({ ...fixture.presentation, configuredModes: new Map(Object.entries(fixture.presentation.configuredModes)) });
    if (fixture.fn === 'runnerDetailPage') {
      const [runner, workspaces, jobs, environment, csrf, release] = args;
      args.splice(0, args.length, { presentation: fixture.presentation,
        runner, workspaces, jobs: jobs ?? undefined, environment: environment ?? undefined, csrf, release });
    }
    const body = views[fixture.fn](...args);
    documents.set('/layout/' + fixture.name, body.startsWith('<!doctype') ? body : adminDocument('Layout fixture', body, 'clients'));
  }
  const [clientData, csrf] = structuredClone(cases.find(fixture => fixture.name === 'clients-populated').args);
  clientData.runners[0].display_name = 'ProductionRunnerWithoutSpaces'.repeat(5);
  clientData.runners[0].runner_id = 'runner-' + '0123456789abcdef'.repeat(2);
  clientData.clients[0] = { ...clientData.clients[0], label: 'TeamClientWithoutSpaces'.repeat(4), active_runner_id: clientData.runners[0].runner_id,
    scopes: ['coding:read', 'coding:write', 'coding:exec'], last_used_at_ms: Date.UTC(2026, 9, 4, 0, 50, 21, 590) };
  clientData.clients.push({ ...clientData.clients[0], client_id: 'client-unselected', active_runner_id: null });
  clientData.clients.push({ ...clientData.clients[0], client_id: 'client-revoked', revoked_at_ms: Date.UTC(2026, 9, 4) });
  documents.set('/layout/clients-long-values', adminDocument('Client layout fixture', clientsPage(clientData, csrf), 'clients'));
  documents.set('/layout/client-detail-long-values', adminDocument('Client detail layout fixture', clientDetailPage(clientData.clients[0], clientData.runners, [], csrf), 'clients'));
  documents.set('/layout/central', adminDocument('MCP & Skill', centralPage('fixture-csrf', true, true), 'central'));
  for (const [name, bootstrap, executionMode] of [
    ['one-command', true, 'dedicated_user'], ['privileged', true, 'privileged_host'], ['manual', false, 'dedicated_user'],
  ]) documents.set('/layout/enrollment-' + name, enrollmentDocument({
    publicBase: 'https://fixture.example', runnerId: 'fixture-runner', code: 'fixture-example-code', csrf: 'fixture-csrf',
    reEnroll: false, bootstrap, executionMode, maxValidityDays: 3650, enrollment: undefined,
  }));
  return documents;
}

// The disposable Node server has no Worker HTMLRewriter. Apply the same text
// translator to server-rendered text, leaving user content and dynamic cards alone.
async function localizeFixture(page, locale) {
  const texts = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), texts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest('script,style,code,pre,[data-no-i18n]')) texts.push(node.textContent);
    }
    return texts;
  });
  const translations = Object.fromEntries(texts.map(text => [text, localizeUiText(text, locale)]));
  await page.evaluate(translations => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest('script,style,code,pre,[data-no-i18n]') && Object.hasOwn(translations, node.textContent)) node.textContent = translations[node.textContent];
    }
  }, translations);
}

async function layoutIssues(page) {
  return page.evaluate(() => {
    const issues = [], rect = node => node.getBoundingClientRect();
    const visible = node => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const inside = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('page overflows horizontally');
    const header = document.querySelector('.app-header');
    if (header) for (const node of header.querySelectorAll('.brand,.control-nav,.header-actions')) {
      if (!inside(rect(node), rect(header))) issues.push('header clips ' + node.className);
    }
    for (const button of document.querySelectorAll('button,.button')) {
      if (!visible(button) || !button.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(button);
      if (!inside(range.getBoundingClientRect(), rect(button))) issues.push('button clips text: ' + button.textContent.trim());
    }
    for (const actions of document.querySelectorAll('.central-card .actions')) {
      if (visible(actions) && !inside(rect(actions), rect(actions.closest('.central-card')))) issues.push('card actions overflow');
    }
    for (const form of document.querySelectorAll('.client-table .inline-action-form')) {
      if (!visible(form) || form.querySelector('input:not([type=hidden]),select,textarea')) continue;
      const button = form.querySelector('button'), area = rect(form), control = rect(button);
      if (['top', 'bottom', 'left', 'right'].some(edge => Math.abs(area[edge] - control[edge]) > 1)) issues.push('client action button does not fill its grid cell');
    }
    for (const cell of document.querySelectorAll('.client-table td')) {
      const area = rect(cell), column = cell.cellIndex + 1;
      if (column === 5 && getComputedStyle(cell).display === 'block') {
        const label = getComputedStyle(cell, '::before').content.slice(1, -1);
        const heading = cell.closest('table').querySelector('th:nth-child(5)').textContent.trim();
        if (label.toLowerCase() !== heading.toLowerCase()) issues.push('mobile client status loses its credential context');
      }
      for (const control of cell.querySelectorAll('input:not([type=hidden]),select,button,a,.runner-selection-controls,.runner-selection-form')) {
        if (visible(control) && !inside(rect(control), area)) issues.push('client column ' + column + ' control crosses its cell boundary');
      }
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent.trim() || text.parentElement.closest('select,option') || !visible(text.parentElement)) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        if ([...range.getClientRects()].some(line => !inside(line, area))) issues.push('client column ' + column + ' text crosses its cell boundary');
      }
    }
    for (const node of document.querySelectorAll('.client-table .credential-badge,.client-table .timestamp>span')) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        if (range.getClientRects().length !== 1) issues.push('client status or timestamp line wraps inside its text');
      }
    }
    for (const timestamp of document.querySelectorAll('.client-table .timestamp')) {
      const [date, clock] = [...timestamp.children].map(rect);
      if (clock.top < date.bottom - 1 || Math.abs(clock.left - date.left) > 1) issues.push('client date and UTC time are not aligned on separate lines');
    }
    const recording = document.querySelector('form[action$="/recording"]');
    if (recording) {
      const items = [...recording.children].filter(node => node.tagName !== 'INPUT').map(rect), area = rect(recording);
      if (items.some(item => !inside(item, area))) issues.push('recording form content crosses its boundary');
      if (items.some((item, index) => index > 0 && item.top < items[index - 1].bottom - 1)) issues.push('recording form label, select, help and action are not in reading order');
      if (items.some(item => Math.abs(item.left - area.left) > 1)) issues.push('recording form fields are not aligned');
    }
    for (const label of document.querySelectorAll('.scope-selector-row .check')) {
      if (!visible(label)) continue;
      const input = rect(label.querySelector('input')), title = rect(label.querySelector('strong'));
      if (Math.abs(input.top + input.height / 2 - title.top - title.height / 2) > 3) issues.push('scope checkbox is not aligned with its title');
      if (input.right > title.left) issues.push('scope checkbox overlaps its text');
    }
    const enrollmentForm = document.querySelector('.enrollment-dialog .dialog-actions form');
    if (enrollmentForm && getComputedStyle(enrollmentForm).flexDirection === 'column') {
      const button = enrollmentForm.querySelector('button');
      const padding = Number.parseFloat(getComputedStyle(enrollmentForm).paddingBottom) || 0;
      if (rect(enrollmentForm).bottom - rect(button).bottom > padding + 2) issues.push('enrollment form retains unused height below its action');
    }
    const form = document.querySelector('.add-client-grid');
    if (form) {
      const labels = [...form.children].filter(node => node.tagName === 'LABEL').map(rect);
      const permissions = rect(form.querySelector('details')), help = rect(form.querySelector('p')), submit = rect(form.querySelector('.form-submit-wrap'));
      if (permissions.top < Math.max(...labels.map(r => r.bottom)) - 1) issues.push('permissions share the input row');
      if (help.top < permissions.bottom - 1 || submit.top < help.bottom - 1) issues.push('help and submit are not below permissions');
      if (Math.abs(submit.left - rect(form).left) > 1) issues.push('submit is not aligned with the form');
    }
    return [...new Set(issues)];
  });
}

/** Geometry and text only: never capture screenshots or use a user's browser. */
export async function checkAdminLayout(executable) {
  const documents = await fixtureDocuments(), errors = [], failures = [];
  const digest = 'a'.repeat(64);
  const profile = { profile_id: 'layout-docs', connector_id: 'layout-docs', display_name: 'Documentation-' + 'long-name-'.repeat(6), endpoint: 'https://docs.example.com/' + 'long-path-'.repeat(10) + '/mcp', revision: 1, enabled: true, authentication: 'oauth', credential: null };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'), locale = url.searchParams.get('lang') === 'zh-CN' ? 'zh-CN' : 'en';
    if (documents.has(url.pathname)) {
      res.setHeader('content-type', 'text/html');
      res.end(documents.get(url.pathname).replace('<html lang="en">', '<html lang="' + locale + '">')); return;
    }
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/admin/central/profiles') res.end(JSON.stringify({ state: 'listed', profiles: [profile], next_after: null }));
    else if (url.pathname === '/admin/central/skills') res.end(JSON.stringify({ state: 'listed', skills: [{ head: { skill_id: 'layout-skill', revision: 1, enabled: true, staged_digest: digest, active_digest: digest }, summary: { name: 'Research-' + 'long-name-'.repeat(6), description: 'Supporting files and documentation for research.' } }], next_after: null }));
    else if (url.pathname === '/admin/central/catalogs/layout-docs') res.end(JSON.stringify({ state: 'found', head: { revision: 1, approved_digest: digest, observed_digest: digest, approved_names: [] }, snapshot: { digest, tools: [] } }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser, measurements = 0;
  try {
    browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
    const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
    for (const locale of ['en', 'zh-CN']) for (const width of viewports) for (const path of documents.keys()) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + path + '?lang=' + locale);
      if (path.endsWith('/central')) await page.locator('[data-central-product][aria-busy="false"]').waitFor();
      await localizeFixture(page, locale);
      const measure = async state => {
        measurements++;
        for (const issue of await layoutIssues(page)) failures.push({ locale, width, path, state, issue });
      };
      await measure('initial');
      if (path.includes('clients-')) {
        const fields = page.locator('.add-client-grid > label');
        const before = await fields.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
        await page.locator('[name=access_mode]').selectOption('native');
        assert.equal(await page.locator('[data-client-computer-permissions]').evaluate(node => node.open), true);
        const after = await fields.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
        if (before.some((r, index) => ['x', 'y', 'width', 'height'].some(key => Math.abs(r[key] - after[index][key]) > 1))) failures.push({ locale, width, path, issue: 'opening permissions moves input fields' });
        await measure('permissions-open');
      }
      if (path.endsWith('/central')) {
        await page.locator('[data-central-tab=skills]').click();
        await measure('skills');
      }
      if (path.includes('runners-')) {
        for (const summary of await page.locator('.row-actions-more summary').all()) await summary.click();
        await measure('actions-open');
      }
      if (path.includes('/enrollment-')) {
        await page.getByRole('tab', { name: 'Windows', exact: true }).click();
        await measure('windows-command');
      }
    }
    // A resized command panel must return to its natural wide-layout height.
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto(origin + '/layout/enrollment-manual');
    await page.setViewportSize({ width: 1365, height: 1000 });
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await settle();
    const resizedHeight = await page.locator('.enrollment-command-panels').evaluate(node => node.getBoundingClientRect().height);
    await page.reload(); await settle();
    const freshHeight = await page.locator('.enrollment-command-panels').evaluate(node => node.getBoundingClientRect().height);
    assert.ok(Math.abs(resizedHeight - freshHeight) <= 1, 'Command panels must release the height measured on a narrow viewport');
    assert.deepEqual(errors, [], 'Layout fixtures must not throw browser errors');
    assert.deepEqual(failures, [], 'UI geometry regressions: ' + JSON.stringify(failures));
    return { state: 'passed', measurements, locales: ['en', 'zh-CN'], viewports, client_cell_content_contained: true, recording_form_order_and_alignment: true, screenshots: 0 };
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await checkAdminLayout(process.env.RUNMESH_CHROMIUM_EXECUTABLE)));
