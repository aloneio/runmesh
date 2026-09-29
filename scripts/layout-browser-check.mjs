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
import { localizeUiText } from '../apps/worker/dist/i18n/legacy-text.js';

// Reuse public render fixtures; measurements exercise the shipped CSS and browser bundle.
const views = { authEntryDocument, secretCreatedPage, overviewPage, settingsPage, clientsPage, clientDetailPage, runnersPage, runnerDetailPage };
async function fixtureDocuments() {
  const { cases } = JSON.parse(await readFile(new URL('../apps/worker/test/fixtures/admin-render-golden.json', import.meta.url), 'utf8'));
  const documents = new Map();
  for (const fixture of cases.filter(f => !f.name.endsWith('-empty') && f.fn !== 'adminDocument')) {
    const args = structuredClone(fixture.args);
    if (fixture.fn === 'runnersPage') args.unshift({ ...fixture.presentation, configuredModes: new Map(Object.entries(fixture.presentation.configuredModes)) });
    if (fixture.fn === 'runnerDetailPage') {
      if (args[2] === null) args[2] = undefined;
      if (args[3] === null) args[3] = undefined;
      args.unshift(fixture.presentation);
    }
    const body = views[fixture.fn](...args);
    documents.set('/layout/' + fixture.name, body.startsWith('<!doctype') ? body : adminDocument('Layout fixture', body, 'clients'));
  }
  documents.set('/layout/central', adminDocument('MCP & Skill', centralPage('fixture-csrf', true, true), 'central'));
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
    for (const label of document.querySelectorAll('.scope-selector-row .check')) {
      if (!visible(label)) continue;
      const input = rect(label.querySelector('input')), title = rect(label.querySelector('strong'));
      if (Math.abs(input.top + input.height / 2 - title.top - title.height / 2) > 3) issues.push('scope checkbox is not aligned with its title');
      if (input.right > title.left) issues.push('scope checkbox overlaps its text');
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
    for (const locale of ['en', 'zh-CN']) for (const width of [320, 390, 768, 900, 1024, 1365]) for (const path of documents.keys()) {
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
    }
    assert.deepEqual(errors, [], 'Layout fixtures must not throw browser errors');
    assert.deepEqual(failures, [], 'UI geometry regressions: ' + JSON.stringify(failures));
    return { state: 'passed', measurements, locales: ['en', 'zh-CN'], viewports: [320, 390, 768, 900, 1024, 1365], screenshots: 0 };
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await checkAdminLayout(process.env.RUNMESH_CHROMIUM_EXECUTABLE)));
