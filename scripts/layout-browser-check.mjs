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
import { loadAdminJobPage } from '../apps/worker/dist/admin-jobs.js';
import { isSafeIdentifier } from '../apps/worker/dist/security.js';
import { PRODUCT_VERSION } from '../apps/worker/dist/generated-version.js';
import { guidedProductStageMarker, withBrowserFixtureCleanup } from './browser-evidence.mjs';

// Reuse public render fixtures; measurements exercise the shipped CSS and browser bundle.
const views = { authEntryDocument, secretCreatedPage, overviewPage, settingsPage, clientsPage, clientDetailPage, runnersPage, runnerDetailPage };
const viewports = [320, 390, 768, 800, 801, 900, 1024, 1050, 1051, 1064, 1365, 1440, 1787];
const runnerUpdateOperation = 'layout-update-operation';
async function fixtureDocuments() {
  const { cases } = JSON.parse(await readFile(new URL('../apps/worker/test/fixtures/admin-render-golden.json', import.meta.url), 'utf8'));
  const documents = new Map();
  for (const fixture of cases.filter(f => f.fn !== 'adminDocument')) {
    const args = structuredClone(fixture.args);
    if (fixture.fn === 'runnersPage') args.unshift({ ...fixture.presentation, configuredModes: new Map(Object.entries(fixture.presentation.configuredModes)) });
    if (fixture.fn === 'runnerDetailPage') {
      const [runner, workspaces, jobs, environment, csrf, release] = args;
      runner.update_request_id = runnerUpdateOperation;
      workspaces.push({ workspace_id: 'Settings', display_name: 'Project', root_path: '/project', validation_status: 'valid' });
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
  const runnerFixture = cases.find(fixture => fixture.name === 'runners-populated');
  const [runnerData, runnerCsrf] = structuredClone(runnerFixture.args);
  const configuredModes = new Map(Object.entries(runnerFixture.presentation.configuredModes));
  const originalRunnerId = runnerData.runners[0].runner_id;
  runnerData.runners[0] = { ...runnerData.runners[0], display_name: 'ProductionRunnerWithoutSpaces'.repeat(5),
    runner_id: 'runner-' + '0123456789abcdef'.repeat(2), last_heartbeat_ms: Date.UTC(2026, 9, 4, 0, 50, 21, 590) };
  configuredModes.set(runnerData.runners[0].runner_id, configuredModes.get(originalRunnerId));
  configuredModes.delete(originalRunnerId);
  documents.set('/layout/runners-long-values', adminDocument('Runner layout fixture', runnersPage({ ...runnerFixture.presentation, configuredModes }, runnerData, runnerCsrf), 'runners'));
  documents.set('/layout/central', adminDocument('MCP & Skill', centralPage('fixture-csrf', true, true), 'central'));
  for (const [name, bootstrap, executionMode] of [
    ['one-command', true, 'dedicated_user'], ['privileged', true, 'privileged_host'], ['manual', false, 'dedicated_user'],
  ]) documents.set('/layout/enrollment-' + name, enrollmentDocument({
    publicBase: 'https://fixture.example', runnerId: 'fixture-runner', code: 'fixture-example-code', csrf: 'fixture-csrf',
    reEnroll: false, bootstrap, executionMode, maxValidityDays: 3650, enrollment: undefined,
  }));
  const jobPage = await loadAdminJobPage(new URL('https://fixture.example/admin/runners/runner/jobs/job'), 'runner', 'job',
    async path => Response.json(path.endsWith('/jobs/job')
      ? { runner_id: 'runner', job_id: 'job', workspace_id: 'work', status: 'succeeded', created_at_ms: 1000, updated_at_ms: 2000 }
      : { runner_id: 'runner', state: 'online' }), async () => undefined);
  assert.equal(jobPage.ok, true);
  documents.set('/layout/job-details', adminDocument(jobPage.title, jobPage.body, 'runners'));
  return documents;
}

// The disposable Node server has no Worker HTMLRewriter. Apply the same text
// translator to server-rendered text, leaving user content and dynamic cards alone.
export async function localizeFixture(page, locale) {
  const attributes = ['aria-label', 'alt', 'placeholder', 'title', 'data-password-show', 'data-password-hide', 'data-submit-pending'];
  const excluded = 'script,style,pre,code,textarea,svg,[data-no-i18n],[translate="no" i],'
    + '[data-service-list],[data-skill-list],[data-service-tools],[data-service-inspection],[data-skill-review],'
    + '[data-skill-history],[data-skill-source-preview],[data-registry-results]';
  const texts = await page.evaluate(({ excluded, attributes }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), texts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest(excluded)) texts.push(node.textContent);
    }
    for (const node of document.querySelectorAll(attributes.map(name => '[' + name + ']').join(','))) if (!node.closest(excluded))
      for (const name of attributes) if (node.hasAttribute(name)) texts.push(node.getAttribute(name));
    return texts;
  }, { excluded, attributes });
  const translations = Object.fromEntries(texts.map(text => [text, localizeUiText(text, locale)]));
  await page.evaluate(({ translations, excluded, attributes }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement.closest(excluded) && Object.hasOwn(translations, node.textContent)) node.textContent = translations[node.textContent];
    }
    for (const node of document.querySelectorAll(attributes.map(name => '[' + name + ']').join(','))) if (!node.closest(excluded))
      for (const name of attributes) {
        const value = node.getAttribute(name);
        if (value !== null && Object.hasOwn(translations, value)) node.setAttribute(name, translations[value]);
      }
  }, { translations, excluded, attributes });
}

async function checkAuthSubmissions(page, origin, auth) {
  let submissions = 0;
  await page.exposeFunction('__runmeshAuthSubmitted', state => auth.pending?.observed.resolve(state));
  for (const locale of ['en', 'zh-CN']) for (const kind of ['login', 'setup']) {
    await page.goto(origin + '/layout/' + kind + '?lang=' + locale);
    await localizeFixture(page, locale);
    const form = page.locator('form.login-form'), button = form.locator('.login-submit-btn');
    const password = 'layout-fixture-password', csrf = await form.locator('[name=csrf_token]').inputValue();
    const show = locale === 'en' ? 'Show password' : '显示密码', hide = locale === 'en' ? 'Hide password' : '隐藏密码';
    for (const field of await form.locator('.password-input-wrap').all()) {
      const input = field.locator('input'), toggle = field.locator('.pwd-toggle-btn');
      await input.fill(password);
      assert.equal(await toggle.getAttribute('aria-label'), show);
      await toggle.click();
      assert.equal(await input.getAttribute('type'), 'text');
      assert.equal(await toggle.getAttribute('aria-label'), hide);
      assert.equal(await toggle.getAttribute('title'), hide);
      await toggle.click();
      assert.equal(await input.getAttribute('type'), 'password');
      assert.equal(await toggle.getAttribute('aria-label'), show);
    }
    const received = Promise.withResolvers(), observed = Promise.withResolvers(), response = Promise.withResolvers();
    const destination = '/layout/auth-complete?kind=' + kind + '&lang=' + locale;
    auth.pending = { path: '/' + kind, received, observed, response, destination };
    // Observe after the shipped submit listener, before navigation begins.
    // Locator reads during a held POST wait for that same navigation to finish.
    await form.evaluate(form => form.addEventListener('submit', () => {
      const button = form.querySelector('.login-submit-btn');
      void window.__runmeshAuthSubmitted({ disabled: button.disabled, text: button.textContent });
    }, { once: true }));
    const deadline = setTimeout(() => {
      const error = new Error('Auth form did not submit within 15 seconds: ' + kind + '/' + locale);
      received.reject(error); observed.reject(error);
    }, 15_000);
    const submission = Promise.all([received.promise, observed.promise]);
    const before = auth.requests.length, click = button.click();
    try {
      const [request, state] = await Promise.race([submission, click.then(() => submission)]);
      assert.equal(state.disabled, true);
      assert.equal(state.text, kind === 'setup'
        ? locale === 'en' ? 'Initializing...' : '正在初始化...'
        : locale === 'en' ? 'Signing in...' : '正在登录...');
      assert.equal(request.method, 'POST');
      assert.match(request.contentType, /^application\/x-www-form-urlencoded(?:;|$)/);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(request.body)), {
        csrf_token: csrf, password, ...(kind === 'setup' ? { confirm_password: password } : {}),
      });
      response.resolve();
      await Promise.all([click, page.waitForURL(origin + destination)]);
      assert.equal(auth.requests.length - before, 1, kind + ' submits exactly one native POST');
      submissions++;
    } finally {
      clearTimeout(deadline);
      response.resolve();
      await click.catch(() => undefined);
      auth.pending = undefined;
    }
  }
  return submissions;
}

async function layoutIssues(page) {
  return page.evaluate(() => {
    const issues = [], rect = node => node.getBoundingClientRect();
    const visible = node => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const inside = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('page overflows horizontally');
    const header = document.querySelector('.app-header');
    if (header) for (const node of header.querySelectorAll('.brand,.product-version,.header-actions')) {
      if (!visible(node)) issues.push('header hides ' + node.className);
      if (!inside(rect(node), rect(header))) issues.push('header clips ' + node.className);
    }
    if (header) {
      const branding = rect(header.querySelector('.header-left')), actions = rect(header.querySelector('.header-actions'));
      if (branding.right > actions.left - 1) issues.push('product branding overlaps header actions');
    }
    const navigation = document.querySelector('.control-nav'), rail = document.querySelector('.nav-rail');
    if (navigation) {
      if (!rail || !rail.contains(navigation)) issues.push('main navigation is outside its rail');
      else {
        if (!inside(rect(navigation), rect(rail))) issues.push('navigation crosses its rail boundary');
        for (const link of navigation.querySelectorAll('a')) {
          if (!visible(link)) issues.push('navigation link is hidden: ' + link.textContent.trim());
          if (!inside(rect(link), rect(navigation)) || !inside(rect(link), rect(rail))) issues.push('navigation link is clipped: ' + link.textContent.trim());
          const range = document.createRange(); range.selectNodeContents(link);
          if ([...range.getClientRects()].some(line => !inside(line, rect(link)))) issues.push('navigation link clips its content: ' + link.textContent.trim());
        }
        const main = document.querySelector('#main-content');
        if (main) {
          const content = rect(main), area = rect(rail);
          if (getComputedStyle(rail).position === 'fixed') {
            if (content.left < area.right - 1 && content.right > area.left + 1 && content.top < area.bottom - 1 && content.bottom > area.top + 1) issues.push('fixed navigation rail overlaps main content');
          } else {
            // The mobile rail belongs to the sticky header. Compare the main's
            // document origin with the header's normal-flow space, not its
            // viewport position after filling a field has scrolled the page.
            const occupiedHeight = header?.contains(rail) ? rect(header).height : area.bottom + scrollY;
            if (content.top + scrollY < occupiedHeight - 1) issues.push('mobile navigation overlaps main content');
          }
        }
      }
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
    for (const cell of document.querySelectorAll('.client-table td,.runner-table td')) {
      const area = rect(cell), column = cell.cellIndex + 1, table = cell.closest('table').classList.contains('client-table') ? 'client' : 'runner';
      const mobileLabel = cell.querySelector('.table-mobile-label');
      if (cell.colSpan > 1) {
        if (mobileLabel) issues.push(table + ' empty state has a column label');
      } else {
        const heading = cell.closest('table').querySelectorAll('th[scope="col"]')[cell.cellIndex];
        if (!mobileLabel || mobileLabel.textContent.trim() !== heading?.textContent.trim()) issues.push(table + ' column ' + column + ' mobile label differs from its heading');
        if (mobileLabel?.getAttribute('aria-hidden') !== 'true') issues.push(table + ' column ' + column + ' repeats its heading for assistive technology');
        if (mobileLabel && visible(mobileLabel) !== (getComputedStyle(cell).display === 'block')) issues.push(table + ' column ' + column + ' label visibility does not match the layout');
        if (mobileLabel && visible(mobileLabel)) {
          const range = document.createRange(); range.selectNodeContents(mobileLabel);
          if ([...range.getClientRects()].some(line => !inside(line, area))) issues.push(table + ' column ' + column + ' clips its mobile label');
        }
      }
      for (const control of cell.querySelectorAll('input:not([type=hidden]),select,button,a,summary,.runner-selection-controls,.runner-selection-form,.runner-actions')) {
        if (visible(control) && !inside(rect(control), area)) issues.push(table + ' column ' + column + ' control crosses its cell boundary');
      }
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent.trim() || text.parentElement.closest('select,option,.sr-only,[hidden],[aria-hidden="true"]') || !visible(text.parentElement)) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        if ([...range.getClientRects()].some(line => !inside(line, area))) issues.push(table + ' column ' + column + ' text crosses its cell boundary');
      }
    }
    for (const node of document.querySelectorAll('.client-table .credential-badge,.client-table .timestamp>span,.runner-table .badge,.runner-table .timestamp>span')) {
      if (!visible(node)) continue;
      const table = node.closest('table').classList.contains('client-table') ? 'client' : 'runner';
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent.trim() || text.parentElement.closest('.sr-only,[hidden],[aria-hidden="true"]')) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        if (range.getClientRects().length !== 1) issues.push(table + ' status or timestamp line wraps inside its text');
      }
    }
    for (const timestamp of document.querySelectorAll('.client-table .timestamp,.runner-table .timestamp')) {
      if (!visible(timestamp)) continue;
      const table = timestamp.closest('table').classList.contains('client-table') ? 'client' : 'runner';
      const [date, clock] = [...timestamp.children].map(rect);
      if (clock.top < date.bottom - 1 || Math.abs(clock.left - date.left) > 1) issues.push(table + ' date and UTC time are not aligned on separate lines');
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

async function checkRunnerVersionForm(page) {
  const form = page.locator('.version-policy-form');
  const channel = form.locator('select[name="update_channel"]');
  const desired = form.locator('input[name="desired_runner_version"]');
  assert.equal(await channel.isVisible(), true, 'Runner version channel must be visible');
  assert.equal(await desired.isVisible(), true, 'Runner target version must be visible');
  assert.equal(await form.getAttribute('method'), 'post');
  assert.match(await form.getAttribute('action'), /^\/admin\/runners\/[^/]+\/version-policy$/);
  const initial = await form.evaluate(node => Object.fromEntries(new FormData(node)));
  assert.deepEqual(Object.keys(initial).sort(), ['csrf_token', ...(initial.update_channel === 'pinned' ? ['desired_runner_version'] : []), 'operation_id', 'update_channel']);
  assert.ok(initial.csrf_token.length > 0, 'Runner version form keeps its CSRF value');
  assert.equal(initial.operation_id, runnerUpdateOperation);
  assert.equal(await desired.isEnabled(), initial.update_channel === 'pinned');
  assert.equal(await desired.evaluate(node => node.required), initial.update_channel === 'pinned');
  assert.deepEqual(await channel.locator('option').evaluateAll(options => options.map(option => option.value)), ['stable', 'pinned']);

  // Exercise old releases and development versions locally; never submit a version change.
  await channel.selectOption('pinned');
  await desired.fill('');
  assert.equal(await form.evaluate(node => node.checkValidity()), false, 'An exact release selection needs a version');
  await desired.fill('0.1.8-beta.1');
  assert.equal(await form.evaluate(node => node.checkValidity()), false);
  await channel.selectOption('stable');
  assert.equal(await desired.isDisabled(), true);
  assert.equal(await form.evaluate(node => node.checkValidity()), true, 'An invalid unused exact version must not block the latest release');
  const { desired_runner_version: _initialDesired, ...initialFields } = initial;
  assert.deepEqual(await form.evaluate(node => Object.fromEntries(new FormData(node))), { ...initialFields, update_channel: 'stable' });
  await channel.selectOption('pinned');
  assert.equal(await desired.inputValue(), '0.1.8-beta.1', 'Channel changes preserve the exact-version draft');
  assert.equal(await form.evaluate(node => node.checkValidity()), false);
  for (const version of ['0.1.6', '0.1.8-dev.45']) {
    await desired.fill(version);
    assert.equal(await form.evaluate(node => node.checkValidity()), true);
    assert.deepEqual(await form.evaluate(node => Object.fromEntries(new FormData(node))), {
      ...initial, update_channel: 'pinned', desired_runner_version: version,
    });
  }
  await channel.selectOption('stable');
  assert.equal(await form.evaluate(node => node.checkValidity()), true, 'Latest release selection needs no exact version');
  assert.deepEqual(await form.evaluate(node => Object.fromEntries(new FormData(node))), {
    ...initialFields, update_channel: 'stable',
  });
  await channel.selectOption('pinned');
  await desired.fill('0.1.6');
}

async function checkIdentifierInputs(page) {
  const cases = ['runner-probe', 'A._:-9', 'a'.repeat(128), 'runner/name', ' space', '汉字', '!', '-first', '_first', 'a'.repeat(129)]
    .map(value => ({ value, valid: isSafeIdentifier(value) }));
  const inputs = page.locator('input[name="runner_id"],input[name="confirmation"][pattern]');
  const results = await inputs.evaluateAll((nodes, cases) => nodes.map(input => {
    const previous = input.value;
    try {
      const checks = cases.map(({ value, valid }) => {
        input.value = value;
        return { value, expected: valid, actual: input.checkValidity(), patternMismatch: input.validity.patternMismatch };
      });
      input.value = '';
      return { name: input.name, checks, emptyValid: input.checkValidity(), required: input.required,
        workspaceId: input.form.querySelector('input[type="hidden"][name="workspace_id"]')?.value, placeholder: input.placeholder };
    } finally { input.value = previous; }
  }), cases);
  assert.ok(results.length > 0, 'Runner forms must expose identifier fields');
  for (const input of results) {
    for (const check of input.checks) {
      assert.equal(check.actual, check.expected, input.name + ': ' + JSON.stringify(check.value));
      assert.equal(check.patternMismatch, !check.expected, 'Native pattern validation: ' + JSON.stringify(check.value));
    }
    assert.equal(input.emptyValid, !input.required, 'Required confirmation and optional generated IDs keep their empty-value behavior');
    if (input.workspaceId !== undefined) assert.equal(input.placeholder, input.workspaceId, 'Workspace confirmation preserves the submitted ID');
  }
  return results.length;
}

/** Local layout and native form validation; never capture screenshots or use a user's browser. */
export async function checkAdminLayout(executable) {
  const stage = value => { const marker = guidedProductStageMarker(value); try { process.stdout.write(marker); } catch { /* Diagnostics do not own fixture cleanup. */ } };
  stage('layout_setup');
  const documents = await fixtureDocuments(), errors = [], failures = [];
  const auth = { requests: [], pending: undefined };
  const digest = 'a'.repeat(64);
  const profile = { profile_id: 'layout-docs', connector_id: 'layout-docs', display_name: 'Documentation-' + 'long-name-'.repeat(6), endpoint: 'https://docs.example.com/' + 'long-path-'.repeat(10) + '/mcp', revision: 1, enabled: true, authentication: 'oauth', credential: null };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'), locale = url.searchParams.get('lang') === 'zh-CN' ? 'zh-CN' : 'en';
    if (req.method === 'POST' && auth.pending?.path === url.pathname) {
      const pending = auth.pending, chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = { method: req.method, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') };
      auth.requests.push(request); pending.received.resolve(request);
      await pending.response.promise;
      res.writeHead(303, { location: pending.destination }); res.end(); return;
    }
    if (url.pathname === '/layout/auth-complete') {
      res.setHeader('content-type', 'text/html'); res.end(documents.get('/layout/login')); return;
    }
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
  let browser, measurements = 0, identifierInputs = 0;
  return withBrowserFixtureCleanup(async () => {
    browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
    const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
    stage('layout_auth');
    const authSubmissions = await checkAuthSubmissions(page, origin, auth);
    for (const locale of ['en', 'zh-CN']) for (const width of viewports) for (const path of documents.keys()) {
      stage('layout_navigation');
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + path + '?lang=' + locale);
      if (path.endsWith('/central')) await page.locator('[data-central-product][aria-busy="false"]').waitFor();
      stage('layout_localization');
      await localizeFixture(page, locale);
      stage('layout_forms');
      if (await page.locator('[data-app-header]').count()) {
        assert.equal(await page.locator('.brand').getAttribute('href'), 'https://github.com/aloneio/runmesh');
        assert.equal(await page.locator('.brand').getAttribute('target'), '_blank');
        assert.equal(await page.locator('.product-version').textContent(), 'v' + PRODUCT_VERSION);
      }
      if (width === 390 && (path === '/layout/runners-populated' || path === '/layout/runner-detail'))
        identifierInputs += await checkIdentifierInputs(page);
      if (path === '/layout/job-details') {
        const form = page.locator('form.scope-editor-form');
        const labels = locale === 'en' ? ['Log stream', 'Log bytes', 'Output position'] : ['日志流', '日志片段大小', '读取位置'];
        for (const label of labels) assert.equal(await form.getByRole('combobox', { name: label, exact: true }).count(), 1);
        assert.equal(await form.getByRole('combobox', { name: '', exact: true }).count(), 0);
        assert.deepEqual(await form.evaluate(node => Object.fromEntries(new FormData(node))), { stream: 'stdout', bytes: '4096', view: 'tail' });
      }
      const measure = async state => {
        stage('layout_measure');
        measurements++;
        for (const issue of await layoutIssues(page)) failures.push({ locale, width, path, state, issue });
        stage('layout_forms');
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
        for (const disclosure of await page.locator('.client-table .row-actions-disclosure').all()) {
          await disclosure.locator('summary').click();
          assert.equal(await disclosure.evaluate(node => node.open), true);
          for (const action of await disclosure.locator('button,input:not([type=hidden])').all()) assert.equal(await action.isVisible(), true);
        }
        await measure('client-actions-open');
      }
      if (path.endsWith('/central')) {
        await page.locator('[data-central-tab=skills]').click();
        await measure('skills');
      }
      if (path.includes('runners-')) {
        for (const summary of await page.locator('.row-actions-more summary').all()) await summary.click();
        await measure('actions-open');
      }
      if (path.includes('runner-detail')) {
        await checkRunnerVersionForm(page);
        await measure('pinned-version');
      }
      if (path.includes('/enrollment-')) {
        await page.getByRole('tab', { name: 'Windows', exact: true }).click();
        await measure('windows-command');
        if (width === 390) {
          // Exercise the shipped copy handler without touching the host clipboard.
          await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: async text => { window.removalCommandCopied = text; } } }));
          const removal = page.locator('.runner-removal-commands');
          await removal.locator('summary').click();
          const commands = await removal.locator('pre code').allTextContents();
          const buttons = await removal.locator('button[data-copy]').all();
          assert.equal(buttons.length, 2, 'Both host command variants have a copy action');
          for (let index = 0; index < buttons.length; index++) {
            assert.equal(await buttons[index].getAttribute('data-copy'), commands[index]);
            await buttons[index].click();
            assert.equal(await page.evaluate(() => window.removalCommandCopied), commands[index], 'Copy exactly the displayed uninstall command');
            assert.equal(await buttons[index].textContent(), locale === 'en' ? 'Copied' : '已复制');
          }
          await measure('removal-commands-copied');
        }
      }
    }
    // A resized command panel must return to its natural wide-layout height.
    stage('layout_resize');
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
    return { state: 'passed', measurements, locales: ['en', 'zh-CN'], viewports, navigation_rail_contained: true,
      client_cell_content_contained: true, runner_cell_content_contained: true, runner_version_form_preserved: true,
      recording_form_order_and_alignment: true, uninstall_command_copy_preserved: true, identifier_inputs_validated: identifierInputs,
      native_auth_submissions: authSubmissions, screenshots: 0 };
  }, [
    { phase: 'browser_close', run: () => { stage('layout_cleanup'); return browser?.close(); } },
    { phase: 'fixture_close', run: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  ], text => process.stderr.write(text));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await checkAdminLayout(process.env.RUNMESH_CHROMIUM_EXECUTABLE)));
