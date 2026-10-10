import assert from "node:assert/strict";
import { test } from "node:test";
import { createCentralApi } from "../apps/worker/browser/central/api.js";
import { classifyCentralFailure } from "../apps/worker/browser/central/failures.js";
import { createCentralTranslator } from "../apps/worker/browser/central/messages.js";
import { bindCentralProduct } from "../apps/worker/browser/central/controller.js";
import { createCentralView } from "../apps/worker/browser/central/view.js";
import { createSkillHistory } from "../apps/worker/browser/central/skill-history.js";
import { createSkillWorkflow } from "../apps/worker/browser/central/skills.js";
import { bindSkillSource } from "../apps/worker/browser/central/skill-source.js";
import { createServiceInspection } from "../apps/worker/browser/central/service-inspection.js";
import { createServiceWorkflow } from "../apps/worker/browser/central/services.js";
import { bindRegistryImport } from "../apps/worker/browser/central/registry.js";
import { createCentralOperations } from "../apps/worker/browser/central/operations.js";
import { centralRequestContract, centralRequestScope } from "../apps/worker/browser/central/request-contract.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixtureEventMethods() {
  const listeners = new Map();
  return {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name, event = { preventDefault() {} }) {
      const current = listeners.get(name);
      for (const listener of [...current ?? []]) if (current.has(listener)) listener.call(this, event);
      return !event.defaultPrevented;
    },
    dispatchEvent(event) { return this.dispatch(event.type, event); },
  };
}

test("Central translations expand only template-owned parameters once and preserve missing values", () => {
  for (const locale of ["en", "zh-CN"]) {
    const t = createCentralTranslator(locale);
    const bytes = "$& $` $' {count}";
    const capacity = t("skillVersionCapacity", { count: "{max}", max: 32, bytes });
    assert.equal(capacity, "{max} / 32 " + (locale === "en" ? "versions" : "个版本") + " · " + bytes);
    const title = t("skillHistoryTitle");
    assert.equal(t("skillHistoryTitle", {}), title);
    assert.equal(t("skillHistoryTitle", { unrelated: "unused" }), title);
    assert.equal(t("skillHistoryTitle", Object.create({ name: "inherited" })), title);
    assert.equal(t("skillHistoryTitle", { name: "" }), title.replace("{name}", ""));
    assert.equal(t("inspectionToolsChecked", { count: 0 }), locale === "en" ? "Tool list checked · 0 tools" : "工具列表检查完成 · 0 个工具");
  }
});

test("central request contracts keep recovery scopes and read-only POST receipts aligned", () => {
  const cases = [
    ['profiles?after=page-1', undefined, false, 'mcp-list', false, ['listed'], 'profiles'],
    ['skills?after=page-1', undefined, false, 'skills', false, ['listed'], 'skills'],
    ['profiles/service', { action: 'connect' }, false, 'mcp-create', true, ['written']],
    ['profiles/cloud%2Fdocs', { action: 'enable' }, false, 'mcp:cloud/docs', true, ['written']],
    ['catalogs/cloud%2Fdocs', undefined, false, 'mcp:cloud/docs', false, ['found']],
    ['catalogs/cloud%2Fdocs', undefined, true, 'mcp:cloud/docs', false, ['found', 'empty']],
    ['catalogs/cloud%2Fdocs', { action: 'approve' }, true, 'mcp:cloud/docs', true, ['written']],
    ['discovery/cloud%2Fdocs', { expected_revision: 0 }, false, 'mcp:cloud/docs', true, ['written', 'authorization_required']],
    ['connections/begin', { profile_id: 'cloud/docs' }, false, 'mcp:cloud/docs', true, ['started']],
    ['connections/revoke', { profile_id: 'cloud/docs' }, false, 'mcp:cloud/docs', true, ['revoked']],
    ['connection-check', { profile_id: 'cloud/docs' }, false, 'mcp:cloud/docs', false, ['inspected', 'authorization_required']],
    ['connection-check', { endpoint: 'https://docs.example/mcp' }, false, 'mcp-create', false, ['inspected', 'authorization_required']],
    ['registry-preview', { name: 'docs' }, false, 'mcp-create', false, ['previewed']],
    ['skill-installations', { files: [] }, false, 'skills', true, ['installed']],
    ['skills/research?digest=version', undefined, true, 'skills', false, ['found']],
    ['skills/research', { action: 'preview' }, false, 'skills', false, ['previewed']],
    ['skills/research', { action: 'activate' }, false, 'skills', true, ['written']],
    ['skills/research/versions', undefined, false, 'skills', false, ['listed']],
    ['skills/research/compare', { before: 'one', after: 'two' }, false, 'skills', false, ['compared']],
    ['skills/research/cleanup-preview', { digests: [] }, false, 'skills', false, ['previewed']],
    ['skills/research/cleanup', { fingerprint: 'plan' }, false, 'skills', true, ['cleaned']],
    ['skills/research/retention', { pinned: true }, false, 'skills', true, ['retained']],
    ['skill-source/preview', { source: {} }, false, 'skills', false, ['previewed']],
    ['skill-source/install', { source: {} }, false, 'skills', true, ['written']],
  ];
  for (const [path, body, missing, scope, mutation, states, collection = null] of cases) {
    Object.freeze(body);
    const contract = centralRequestContract(path, body, missing);
    assert.deepEqual({ scope: contract.scope, mutation: contract.mutation, states: contract.states }, { scope, mutation, states }, path);
    assert.equal(contract.collection, collection, path);
  }
  const encoded = centralRequestContract('skills/research%2Fnotes/versions');
  assert.deepEqual(encoded.lifecycle, { id: 'research/notes', operation: 'versions', readOnly: true, state: 'listed' });
});

test("request contracts identify workflow receipts and correction guidance at the same route boundary", () => {
  const cases = [
    ['profiles', undefined, null, false, false, false, false],
    ['profiles/service', undefined, null, false, false, false, false],
    ['profiles/cloud%2Fdocs', { action: 'connect' }, { id: 'cloud/docs' }, false, false, true, false],
    ['profiles/cloud%252Fdocs', { action: 'enable' }, { id: 'cloud%2Fdocs' }, false, false, false, false],
    ['profiles/service', { action: 'disable' }, { id: 'service' }, false, false, false, false],
    ['profiles-extra/service', { action: 'connect' }, null, false, false, false, false],
    ['connections/begin', undefined, null, false, false, false, false],
    ['connections/begin', { profile_id: 'service' }, null, true, false, false, false],
    ['connections/begin-extra', { profile_id: 'service' }, null, false, false, false, false],
    ['connections/revoke', { profile_id: 'service' }, null, false, false, false, false],
    ['discovery/service', { expected_revision: 1 }, null, false, false, false, false],
    ['skill-installations', { files: [] }, null, false, true, false, true],
    ['skill-installations-extra', { files: [] }, null, false, false, false, false],
    ['skills/research', { action: 'preview' }, null, false, false, false, true],
    ['skills/research', { action: 'activate' }, null, false, false, false, false],
    ['skills-extra/research', { action: 'preview' }, null, false, false, false, false],
    ['skill-source/install', {}, null, false, false, false, false],
  ];
  for (const [path, body, profileWrite, authorizationStart, skillInstallation, serviceInput, skillInput] of cases) {
    const request = centralRequestContract(path, body);
    assert.deepEqual({ profileWrite: request.profileWrite, authorizationStart: request.authorizationStart,
      skillInstallation: request.skillInstallation, serviceInput: request.serviceInput, skillInput: request.skillInput },
    { profileWrite, authorizationStart, skillInstallation, serviceInput, skillInput }, path);
  }
});

test("Remote recovery serializes one MCP while independent foreground workflows remain usable", async () => {
  const controls = ['mcp:a', 'mcp:b', 'skills', 'library', null].map(scope => ({ disabled: false, isConnected: true,
    getAttribute: () => scope }));
  const state = new Map(), app = { querySelectorAll: () => controls, setAttribute: (name, value) => state.set(name, value) };
  const failures = [], events = [], gate = deferred();
  let current = true;
  const ops = createCentralOperations({ app, isCurrent: () => current, working() {}, reportError: error => failures.push(error) });
  const recovery = ops.run(async () => { events.push('recover a'); await gate.promise; }, 'mcp:a', { background: true });
  assert.deepEqual(controls.map(control => control.disabled), [true, false, false, false, false]);
  assert.equal(state.get('aria-busy'), 'false');
  await ops.run(() => events.push('duplicate a'), 'mcp:a');
  await ops.run(() => events.push('pause b'), 'mcp:b');
  await ops.run(() => events.push('install skill'), 'skills');
  await ops.run(() => events.push('refresh lists'), 'library');
  assert.deepEqual(events, ['recover a', 'pause b', 'install skill', 'refresh lists']);
  const stale = ops.run(() => events.push('stale queued a'), 'mcp:a', { background: true });
  current = false;
  gate.resolve(); await recovery; await stale;
  assert.equal(events.includes('stale queued a'), false, 'A queued recovery cannot start after navigation');
  assert.deepEqual(controls.map(control => control.disabled), [false, false, false, false, false]);
  assert.deepEqual(failures, []);
});

test("An uncertain MCP receipt fences that connection without fencing independent Skills", async t => {
  const uncertain = new Set(), requests = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    requests.push(path);
    return path.endsWith('discovery/a') ? Response.json({ state: 'listed' })
      : Response.json({ state: 'written', profile: { profile_id: 'b', revision: 2, enabled: false, authentication: 'none' } });
  });
  const api = createCentralApi({ csrf: 'csrf', t: key => key, isCurrent: () => true,
    refreshRequired: scope => uncertain.has(scope),
    requireRefresh: scope => uncertain.add(scope) });
  await assert.rejects(api.request('discovery/a', { expected_revision: 0 }), unexpected);
  await assert.rejects(api.request('profiles/a', { action: 'disable', expected_revision: 1 }), /refreshTheLibrary/u);
  await api.request('profiles/b', { action: 'disable', expected_revision: 1 });
  assert.equal(uncertain.has(centralRequestScope('skill-installations', {})), false);
  assert.deepEqual(requests, ['/admin/central/discovery/a', '/admin/central/profiles/b']);
  assert.equal(centralRequestScope('profiles/new-a', { action: 'connect' }), centralRequestScope('profiles/new-b', { action: 'connect' }),
    'Creating a fresh ID cannot bypass an uncertain form submission');
});
function client(t, send, translate = key => key) {
  let current = true, refresh = false;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (...args) => { requests.push(args); return send(...args); });
  const api = createCentralApi({ csrf: "fixture-csrf", t: translate, isCurrent: () => current,
    refreshRequired: () => refresh, requireRefresh: () => { refresh = true; } });
  return { ...api, requests, detach: () => { current = false; }, refreshRequired: () => refresh };
}
const unexpected = /unexpectedResponseRefreshBeforeMakingAnotherChange/u;
const writtenProfile = { state: "written", profile: { profile_id: "service", revision: 2, enabled: true, authentication: "none" } };
const installedSkill = { state: "installed", skill_id: "research", name: "Research", digest: "a".repeat(64) };
function successReceipt(path, state) {
  const collection = path.split('?')[0];
  if (state === 'listed' && ['profiles', 'skills'].includes(collection)) return { state, [collection]: [], next_after: null };
  if (state === "written" && path.startsWith("profiles/")) return writtenProfile;
  if (state === "installed") return installedSkill;
  if (state === "started") return { state, authorization_url: "https://provider.example/authorize" };
  return { state };
}

for (const [name, path, body, receipt] of [
  ["missing created profile", "profiles/service", { action: "connect" }, { state: "written" }],
  ["missing updated profile", "profiles/service", { action: "enable", expected_revision: 1 }, { state: "written", profile: null }],
  ["different profile identity", "profiles/service", { action: "connect" }, { ...writtenProfile, profile: { ...writtenProfile.profile, profile_id: "another-service" } }],
  ["missing profile revision", "profiles/service", { action: "connect" }, { ...writtenProfile, profile: { ...writtenProfile.profile, revision: undefined } }],
  ["invalid profile revision", "profiles/service", { action: "enable", expected_revision: 1 }, { ...writtenProfile, profile: { ...writtenProfile.profile, revision: "2" } }],
  ["ambiguous enabled state", "profiles/service", { action: "disable", expected_revision: 1 }, { ...writtenProfile, profile: { ...writtenProfile.profile, enabled: "false" } }],
  ["unknown authentication", "profiles/service", { action: "connect" }, { ...writtenProfile, profile: { ...writtenProfile.profile, authentication: "unsupported" } }],
  ["retired bearer authentication", "profiles/service", { action: "connect" }, { ...writtenProfile, profile: { ...writtenProfile.profile, authentication: "bearer" } }],
  ["missing OAuth URL", "connections/begin", { profile_id: "service", expected_revision: 1 }, { state: "started" }],
  ["empty OAuth URL", "connections/begin", { profile_id: "service", expected_revision: 1 }, { state: "started", authorization_url: "" }],
  ["malformed OAuth URL", "connections/begin", { profile_id: "service", expected_revision: 1 }, { state: "started", authorization_url: "https://[" }],
  ["missing installed Skill identity", "skill-installations", { files: [], expected_revision: 0 }, { ...installedSkill, skill_id: undefined }],
  ["missing installed Skill digest", "skill-installations", { files: [], expected_revision: 0 }, { ...installedSkill, digest: undefined }],
  ["invalid installed Skill name", "skill-installations", { files: [], expected_revision: 0 }, { ...installedSkill, name: {} }],
]) test("incomplete success receipt blocks another write: " + name, async t => {
  const api = client(t, () => Response.json(receipt));
  await assert.rejects(api.request(path, body), unexpected);
  assert.equal(api.refreshRequired(), true);
  await assert.rejects(api.request(path, body), /refreshTheLibraryBeforeMakingAnotherChange/u);
  assert.equal(api.requests.length, 1, "A receipt missing required workflow fields must not admit a repeat mutation");
});

test("a committed create with an incomplete receipt cannot create a duplicate from the same form", async t => {
  function element() {
    return { isConnected: true, disabled: false, textContent: "", style: {}, children: [],
      ...fixtureEventMethods(),
      setAttribute() {}, getAttribute() {}, append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; },
      querySelector: () => null, querySelectorAll: () => [], classList: { toggle() {} }, scrollIntoView() {},
    };
  }
  const original = new Map(["document", "location"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of original) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  const status = element(), form = element(), refresh = element(), list = element(), app = element();
  const fields = { endpoint: { value: "https://public.example/mcp" }, authentication: { value: "none" }, name: { value: "Unsaved service", maxLength: 64 } };
  form.elements = fields; form.reset = () => assert.fail("The incomplete creation cannot finish the form workflow");
  app.getAttribute = name => name === "data-skills" ? "false" : "fixture-csrf";
  app.querySelector = selector => ({ "[data-product-status]": status, "[data-service-create]": form,
    "[data-product-refresh]": refresh, "[data-service-list]": list })[selector] ?? null;
  Object.assign(globalThis, { document: { documentElement: { lang: "en" }, createElement: element }, location: { href: "https://worker.test/admin/central" } });
  let creates = 0, reads = 0;
  const profiles = [];
  t.mock.method(globalThis, "fetch", async (path, options) => {
    if (options.method === "GET") {
      reads++;
      return Response.json({ state: "listed", profiles, ...(reads === 2 ? {} : { next_after: null }) });
    }
    const body = JSON.parse(options.body);
    assert.equal(body.action, "connect"); creates++;
    profiles.push({ profile_id: path.split("/").at(-1), connector_id: body.connector_id, display_name: body.display_name,
      endpoint: body.endpoint, authentication: body.authentication, revision: 1, enabled: false });
    return Response.json({ state: "written" });
  });
  bindCentralProduct({ querySelector: () => app }, { isCurrent: () => true, navigate() {}, replaceCurrentUrl() {} });
  await new Promise(setImmediate);
  const submit = async () => { form.dispatch("submit", { preventDefault() {}, currentTarget: form }); await new Promise(setImmediate); };
  await submit();
  assert.equal(status.textContent, "Unexpected response. Refresh before making another change.");
  await submit();
  assert.equal(creates, 1);
  assert.equal(reads, 1);
  assert.equal(fields.name.value, "Unsaved service");
  assert.equal(status.textContent, "Refresh before making another change.");
  refresh.dispatch("click"); await new Promise(setImmediate);
  assert.equal(reads, 2);
  assert.equal(status.textContent, "Unexpected response. Refresh before making another change.");
  await submit();
  assert.equal(creates, 1, "An incomplete collection cannot release the uncertain create for another write");
  assert.equal(status.textContent, "Refresh before making another change.");
  refresh.dispatch("click"); await new Promise(setImmediate);
  assert.equal(reads, 3, "A complete explicit refresh remains available to reconcile the committed create");
  assert.equal(creates, 1, "Refresh never automatically repeats the creation");
  const labels = node => [node.textContent, ...node.children.flatMap(labels)];
  assert.ok(labels(list).includes("Unsaved service"), "Refresh renders the already-created service for recovery");
});

test("complete profile, OAuth and Skill receipts remain unchanged and admit the next workflow step", async t => {
  const cases = [
    ["profiles/service", { action: "connect" }, { ...writtenProfile, profile: { ...writtenProfile.profile, revision: 1, enabled: false, authentication: "oauth" } }],
    ["profiles/service", { action: "enable", expected_revision: 1 }, writtenProfile],
    ["profiles/service", { action: "disable", expected_revision: 2 }, { ...writtenProfile, profile: { ...writtenProfile.profile, revision: 3, enabled: false } }],
    ["connections/begin", { profile_id: "service", expected_revision: 2 }, { state: "started", authorization_url: "https://provider.example/authorize?state=opaque" }],
    ["connections/begin", { profile_id: "service", expected_revision: 2 }, { state: "started", authorization_url: "/oauth-fixture" }],
    ["skill-installations", { files: [], expected_revision: 0 }, installedSkill],
    ["skill-installations", { files: [], expected_revision: 7 }, { ...installedSkill, digest: "b".repeat(64) }],
  ];
  let index = 0;
  const api = client(t, () => Response.json(cases[index++][2]));
  for (const [path, body, receipt] of cases) assert.deepEqual(await api.request(path, body), receipt);
  assert.equal(api.requests.length, cases.length);
  assert.equal(api.refreshRequired(), false);
});

test("profile reads and encoded profile mutations keep their separate receipt requirements", async t => {
  const cases = [
    ['profiles/service', undefined, { state: 'found' }],
    ['profiles/cloud%2Fdocs', { action: 'enable', expected_revision: 1 },
      { ...writtenProfile, profile: { ...writtenProfile.profile, profile_id: 'cloud/docs' } }],
    ['profiles/cloud%252Fdocs', { action: 'disable', expected_revision: 1 },
      { ...writtenProfile, profile: { ...writtenProfile.profile, profile_id: 'cloud%2Fdocs', enabled: false } }],
  ];
  let index = 0;
  const api = client(t, () => Response.json(cases[index++][2]));
  for (const [path, body, receipt] of cases) assert.deepEqual(await api.request(path, body), receipt);
  assert.equal(api.refreshRequired(), false);
  assert.deepEqual(api.requests.map(([url, options]) => [url, options.method]),
    cases.map(([path, body]) => ['/admin/central/' + path, body === undefined ? 'GET' : 'POST']));
});

for (const locale of ["en", "zh-CN"]) test("OAuth deployment configuration failures give specific " + locale + " guidance", async t => {
  const translate = createCentralTranslator(locale);
  const api = client(t, () => Response.json({ error: { code: "oauth_configuration_required", operation_state: "not_started" } }, { status: 503 }), translate);
  await assert.rejects(api.request("connections/begin", { profile_id: "service", expected_revision: 1 }), { message: translate("oauthConfigurationRequired") });
  assert.equal(api.requests.length, 1);
});

for (const locale of ["en", "zh-CN"]) for (const path of ["connection-check", "discovery/service"])
for (const state of ["not_started", "unknown"]) for (const [code, key] of [
  ["remote_upstream_unavailable", "mcpServiceUnavailable"],
  ["remote_upstream_protocol_error", "mcpResponseInvalid"],
  ["remote_result_invalid", "mcpResponseInvalid"],
  ["remote_dependency_unavailable", "mcpConnectionUnavailable"],
]) test(`${path} reports ${code} with ${state} recovery in ${locale}`, async t => {
  const translate = createCentralTranslator(locale);
  const api = client(t, () => Response.json({ error: { code, operation_state: state, message: "PRIVATE_UPSTREAM_DETAIL" } }, { status: 503 }), translate);
  const messageKey = key + (state === "unknown" ? "Unconfirmed" : "");
  await assert.rejects(api.request(path, { expected_revision: 1 }), { message: translate(messageKey) });
  assert.equal(api.refreshRequired(), path.startsWith("discovery/"), "Specific guidance must preserve mutation reconciliation");
  assert.equal(api.requests.length, 1);
});

test("connection inspection retains endpoint rejection guidance", async t => {
  const api = client(t, () => Response.json({ error: { code: "remote_egress_denied", operation_state: "not_started" } }, { status: 503 }));
  await assert.rejects(api.request("connection-check", { endpoint: "https://private.example/mcp" }), { message: "enterAPublicHttpsMcpUrlPrivateAddressesAnd" });
  assert.equal(api.refreshRequired(), false);
});

test("MCP cause guidance requires its matching status and operation-state receipt", () => {
  for (const [status, code, operation_state] of [
    [400, "remote_upstream_unavailable", "not_started"],
    [503, "remote_upstream_protocol_error", "completed"],
    [503, "remote_dependency_unavailable", undefined],
    [503, "__proto__", "not_started"],
  ]) {
    const result = classifyCentralFailure(centralRequestContract("discovery/service", {}), status, { error: { code, operation_state } });
    assert.deepEqual(result, { messageKey: status === 400 ? "invalidActionRefreshLibrary" : "operationCouldNotBeConfirmedRefreshTheCurrentState", confirmedNotStarted: false });
  }
});

for (const locale of ["en", "zh-CN"]) for (const failure of ["network", "json", "body_abort"])
test("native " + failure + " failures use " + locale + " UI guidance and never replay a write", async t => {
  const translate = createCentralTranslator(locale);
  const api = client(t, () => {
    if (failure === "network") throw new TypeError("PRIVATE_NETWORK_DETAIL");
    if (failure === "body_abort") return { json: () => Promise.reject(new DOMException("PRIVATE_ABORT_DETAIL", "AbortError")) };
    return new Response("PRIVATE_INVALID_RESPONSE_BODY", { status: 200, headers: { "content-type": "application/json" } });
  }, translate);
  const expected = translate(failure === "json" ? "unexpectedResponseRefreshBeforeMakingAnotherChange" : "connectionInterruptedRefreshToCheckWhetherTheOperationCompleted");
  await assert.rejects(api.request("profiles/service", { action: "enable" }), { message: expected });
  assert.equal(api.refreshRequired(), true);
  await assert.rejects(api.request("profiles/service", { action: "enable" }), { message: translate("refreshTheLibraryBeforeMakingAnotherChange") });
  assert.equal(api.requests.length, 1);
});

test("central browser accepts only the expected receipt for each operation", async t => {
  const cases = [
    ["profiles", undefined, "listed"], ["skills?after=page-1", undefined, "listed"],
    ["catalogs/service", undefined, "found"], ["skills/research", undefined, "found"],
    ["profiles/service", { action: "enable" }, "written"], ["discovery/service", {}, "written"],
    ["catalogs/service", { action: "approve" }, "written"], ["skills/research", { action: "preview" }, "previewed"],
    ["skill-installations", { files: [] }, "installed"], ["connections/begin", {}, "started"], ["connections/revoke", {}, "revoked"],
  ];
  let index = 0;
  const api = client(t, () => { const [path, , state] = cases[index++]; return Response.json(successReceipt(path, state)); });
  for (const [path, body, state] of cases) assert.equal((await api.request(path, body)).state, state);
  assert.equal(api.requests.length, cases.length);
  assert.equal(api.refreshRequired(), false);
});

for (const [path, body] of [
  ["profiles/service", { action: "enable" }], ["discovery/service", {}], ["catalogs/service", { action: "approve" }],
  ["skills/research", { action: "activate" }], ["skill-installations", { files: [] }], ["connections/begin", {}], ["connections/revoke", {}],
]) test("a listed receipt cannot confirm or replay " + path, async t => {
  const api = client(t, () => Response.json({ state: "listed" }));
  await assert.rejects(api.request(path, body), unexpected);
  assert.equal(api.refreshRequired(), true);
  await assert.rejects(api.request(path, body), /refreshTheLibraryBeforeMakingAnotherChange/u);
  assert.equal(api.requests.length, 1);
});

for (const value of [null, [], "written"]) test("malformed browser receipt is rejected: " + JSON.stringify(value), async t => {
  const api = client(t, () => Response.json(value));
  await assert.rejects(api.request("profiles/service", { action: "disable" }), unexpected);
  assert.equal(api.refreshRequired(), true);
});

test("a single-item receipt cannot masquerade as a complete collection", async t => {
  const api = client(t, () => Response.json({ state: "found", profiles: [], next_after: null }));
  await assert.rejects(api.list("profiles"), unexpected);
});

for (const collection of ["profiles", "skills"]) {
  for (const [name, fields] of [
    ["missing items", { next_after: null }],
    ["non-array items", { [collection]: {}, next_after: null }],
    ["missing cursor", { [collection]: [] }],
    ["empty cursor", { [collection]: [], next_after: "" }],
    ["non-string cursor", { [collection]: [], next_after: 0 }],
  ]) test(`collection receipts reject ${collection} with ${name}`, async t => {
    const api = client(t, () => Response.json({ state: "listed", ...fields }));
    await assert.rejects(api.list(collection), unexpected);
    assert.equal(api.requests.length, 1);
    assert.equal(api.refreshRequired(), false, "An invalid read never becomes an uncertain mutation");
  });
  test(`collection pagination gathers complete ${collection} pages in order`, async t => {
    const items = [{ id: "first" }, { id: "second" }];
    let page = 0;
    const api = client(t, () => Response.json({ state: "listed", [collection]: [items[page]], next_after: page++ ? null : "page/2" }));
    assert.deepEqual(await api.list(collection), items);
    assert.deepEqual(api.requests.map(([url]) => url), [`/admin/central/${collection}`, `/admin/central/${collection}?after=page%2F2`]);
    assert.equal(api.refreshRequired(), false);
  });
  test(`collection pagination terminates an empty ${collection} page without following its cursor`, async t => {
    const api = client(t, () => Response.json({ state: "listed", [collection]: [], next_after: "page-2" }));
    await assert.rejects(api.list(collection), /couldNotLoadTheCompleteLibraryRefreshBeforeChanging/u);
    assert.equal(api.requests.length, 1);
  });
  test(`collection pagination terminates a repeated ${collection} cursor`, async t => {
    const api = client(t, () => Response.json({ state: "listed", [collection]: [{ id: "item" }], next_after: "page-2" }));
    await assert.rejects(api.list(collection), /couldNotLoadTheCompleteLibraryRefreshBeforeChanging/u);
    assert.equal(api.requests.length, 2);
  });
  for (const size of [1000, 1001]) test(`collection pagination applies the ${collection} size boundary at ${size} entries`, async t => {
    const items = Array.from({ length: size }, (_, id) => ({ id }));
    let page = 0;
    const api = client(t, () => Response.json({ state: "listed", [collection]: page++ ? items.slice(500) : items.slice(0, 500), next_after: page === 1 ? "page-2" : null }));
    if (size === 1000) assert.deepEqual(await api.list(collection), items);
    else await assert.rejects(api.list(collection), /libraryIsTooLargeToDisplay/u);
    assert.equal(api.requests.length, 2);
  });
}

test("empty catalog remains an explicit successful optional read", async t => {
  const api = client(t, () => Response.json({ state: "empty" }));
  assert.equal(await api.request("catalogs/service", undefined, true), null);
  await assert.rejects(api.request("catalogs/service"), unexpected);
});

test("a missing service is not mistaken for an empty catalog", async t => {
  const api = client(t, () => Response.json({ error: { code: "central_missing" } }, { status: 404 }));
  await assert.rejects(api.request("catalogs/service", undefined, true), /operationCouldNotBeConfirmedRefreshTheCurrentState/u);
});

test("discovery awaiting authorization returns a workflow result without claiming publication", async t => {
  const api = client(t, () => Response.json({ state: "authorization_required" }));
  assert.deepEqual(await api.request("discovery/service", { expected_revision: 0 }), { state: "authorization_required" });
  assert.equal(api.requests.length, 1);
  assert.equal(api.refreshRequired(), false);
});

test("failure classification keeps protocol guidance and confirmed recovery metadata together", () => {
  const cases = [
    ["profiles/service", { action: "connect" }, 400, { error: { code: "central_invalid", operation_state: "not_started" } },
      { messageKey: "checkServiceNameAndPublicMcpUrl", confirmedNotStarted: true }],
    ["skill-installations", { files: [] }, 413, { error: { code: "central_request_too_large", operation_state: "not_started" } },
      { messageKey: "skillUploadTooLarge", confirmedNotStarted: true }],
    ["skill-source/install", {}, 429, { error: { code: "skill_capacity", operation_state: "not_started" } },
      { messageKey: "skillLibraryLimitReached", confirmedNotStarted: true, details: { skillCapacity: true } }],
    ["skill-installations", {}, 409, { state: "conflict", skill_id: "research", current_revision: 7 },
      { message: "skill_exists", confirmedNotStarted: false, details: { skillId: "research", revision: 7 } }],
    ["skill-source/install", {}, 503, { error: { code: "skill_source_busy", operation_state: "not_started" } },
      { messageKey: "skillSourceBusy", confirmedNotStarted: true }],
    ["skill-source/install", {}, 503, { error: { code: "skill_source_busy", operation_state: "unknown" } },
      { messageKey: "operationCouldNotBeConfirmedRefreshTheCurrentState", confirmedNotStarted: false }],
    ["connections/begin", {}, 400, { error: { code: "oauth_configuration_required" } },
      { messageKey: "invalidActionRefreshLibrary", confirmedNotStarted: false }],
    ["connections/begin", {}, 503, { error: { code: "oauth_configuration_required" } },
      { messageKey: "oauthConfigurationRequired", confirmedNotStarted: false }],
    ["discovery/service", {}, 404, { error: { code: "central_disabled", operation_state: "not_started" } },
      { messageKey: "centralSetupRequired", confirmedNotStarted: false }],
    ["discovery/service", {}, 429, { error: { code: "remote_busy", operation_state: "not_started" } },
      { messageKey: "mcpBusy", confirmedNotStarted: false }],
    ["connection-check", {}, 429, { error: { code: "remote_busy", operation_state: "not_started" } },
      { messageKey: "mcpBusy", confirmedNotStarted: false }],
    ["discovery/service", {}, 503, { error: { code: "remote_operation_timed_out", operation_state: "not_started" } },
      { messageKey: "mcpTimedOut", confirmedNotStarted: false }],
    ["discovery/service", {}, 503, { error: { code: "remote_operation_timed_out", operation_state: "unknown" } },
      { messageKey: "mcpTimeoutUnconfirmed", confirmedNotStarted: false }],
    ["connection-check", {}, 503, { error: { code: "central_authority_unavailable", operation_state: "not_started" } },
      { messageKey: "sessionVerificationUnavailable", confirmedNotStarted: false }],
  ];
  for (const [path, body, status, value, expected] of cases) {
    Object.freeze(body); Object.freeze(value.error); Object.freeze(value);
    assert.deepEqual(classifyCentralFailure(centralRequestContract(path, body), status, value), expected);
  }
});

for (const [code, status, messageKey] of [
  ['central_disabled', 404, 'centralSetupRequired'], ['remote_busy', 429, 'mcpBusy'],
  ['remote_operation_timed_out', 503, 'mcpTimedOut'], ['central_authority_unavailable', 503, 'sessionVerificationUnavailable'],
]) test(`classified ${code} guidance keeps mutation recovery admission`, async t => {
  const api = client(t, () => Response.json({ error: { code, operation_state: 'not_started', message: 'PRIVATE_UPSTREAM_DETAIL' } }, { status }));
  await assert.rejects(api.request('discovery/service', { expected_revision: 1 }), { message: messageKey });
  assert.equal(api.refreshRequired(), true);
  await assert.rejects(api.request('discovery/service', { expected_revision: 1 }), /refreshTheLibraryBeforeMakingAnotherChange/u);
  assert.equal(api.requests.length, 1);
});

test('unconfirmed or mismatched failure receipts never offer capacity or setup retry guidance', () => {
  for (const [status, code, state] of [[503, 'remote_busy', 'not_started'], [429, 'remote_busy', 'unknown'],
    [404, 'central_disabled', 'unknown'], [503, 'central_authority_unavailable', 'unknown']]) {
    const value = classifyCentralFailure(centralRequestContract('discovery/service', {}), status, { error: { code, operation_state: state } });
    assert.deepEqual(value, { messageKey: 'operationCouldNotBeConfirmedRefreshTheCurrentState', confirmedNotStarted: false });
  }
});

for (const operationState of ["not_started", "unknown"]) test("upload size failure preserves " + operationState + " write recovery", async t => {
  const api = client(t, () => Response.json({ error: { code: "central_request_too_large", operation_state: operationState } }, { status: 413 }));
  await assert.rejects(api.request("skill-installations", { files: [] }), {
    message: operationState === "not_started" ? "skillUploadTooLarge" : "operationCouldNotBeConfirmedRefreshTheCurrentState",
  });
  assert.equal(api.refreshRequired(), operationState !== "not_started");
  if (operationState === "unknown") {
    await assert.rejects(api.request("skill-installations", { files: [] }), /refreshTheLibraryBeforeMakingAnotherChange/u);
    assert.equal(api.requests.length, 1, "An uncertain size rejection must not admit another upload");
  }
});

test("failure receipts retain the Skill workflow Error fields through the API boundary", async t => {
  const capacity = client(t, () => Response.json({ error: { code: "skill_capacity", operation_state: "not_started" } }, { status: 429 }));
  await assert.rejects(capacity.request("skill-source/install", {}), { message: "skillLibraryLimitReached", skillCapacity: true });
  assert.equal(capacity.refreshRequired(), false);
  const conflict = client(t, () => Response.json({ state: "conflict", skill_id: "research", current_revision: 7 }, { status: 409 }), key => "translated:" + key);
  await assert.rejects(conflict.request("skill-installations", { files: [] }), { message: "skill_exists", skillId: "research", revision: 7 });
  assert.equal(conflict.refreshRequired(), true, "A conflict requires refreshing before the workflow can confirm its update");
});

test("unknown Skill source errors retain localized guidance and write reconciliation", async t => {
  let code;
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code, operation_state: "not_started" } }, { status: 503 }));
  for (const locale of ["en", "zh-CN"]) {
    const translate = createCentralTranslator(locale);
    for (code of ["constructor", "toString", "__proto__", ["skill_source_missing"], { code: "skill_source_missing" }, "skill_source_new", null]) {
      for (const operation of ["preview", "install"]) {
        let refresh = false;
        const api = createCentralApi({ csrf: "fixture-csrf", t: translate, isCurrent: () => true,
          refreshRequired: () => refresh, requireRefresh: () => { refresh = true; } });
        await assert.rejects(api.request("skill-source/" + operation, {}), {
          name: "Error", message: translate("operationCouldNotBeConfirmedRefreshTheCurrentState")
        });
        assert.equal(refresh, operation === "install", "Only a source write needs reconciliation");
      }
    }
    for (const [knownCode, key] of [["skill_source_invalid", "skillSourceInvalid"], ["skill_source_missing", "skillSourceMissing"],
      ["skill_source_capacity", "skillSourceCapacity"], ["skill_source_changed", "skillSourceChanged"], ["skill_source_unavailable", "skillSourceUnavailable"]]) {
      code = knownCode;
      const api = createCentralApi({ csrf: "fixture-csrf", t: translate, isCurrent: () => true,
        refreshRequired: () => false, requireRefresh() {} });
      await assert.rejects(api.request("skill-source/preview", {}), { name: "Error", message: translate(key) });
    }
  }
});

for (const [path, status] of [["connections/begin", 200], ["profiles/service", 200], ["discovery/service", 503]])
test("authorization-required is only a successful discovery result: " + path + " " + status, async t => {
  const api = client(t, () => Response.json({ state: "authorization_required" }, { status }));
  await assert.rejects(api.request(path, {}));
  assert.equal(api.refreshRequired(), true);
});

for (const [path, body, message] of [
  ["profiles/service", { action: "connect" }, "checkServiceNameAndPublicMcpUrl"],
  ["profiles/service", { action: "enable" }, "invalidActionRefreshLibrary"],
  ["connections/begin", {}, "invalidActionRefreshLibrary"],
  ["discovery/service", {}, "invalidActionRefreshLibrary"],
  ["skills/research", { action: "activate" }, "invalidActionRefreshLibrary"],
  ["skills/research", { action: "preview" }, "checkSkillFilesRequireNameAndDescription"],
  ["skill-installations", { files: [] }, "checkSkillFilesRequireNameAndDescription"],
]) test("invalid " + path + " " + (body.action ?? "request") + " offers relevant recovery guidance", async t => {
  const api = client(t, () => Response.json({ error: { code: "central_invalid_request" } }, { status: 400 }));
  await assert.rejects(api.request(path, body), { message });
  assert.equal(api.refreshRequired(), body.action !== "preview");
  assert.equal(api.requests.length, 1);
});

test("a detached view cannot start reads previews or writes", async t => {
  const api = client(t, () => { throw new Error("No network request expected"); });
  api.detach();
  for (const body of [undefined, { action: "preview" }, { action: "enable" }])
    await assert.rejects(api.request("profiles/service", body), { name: "AbortError" });
  assert.equal(api.requests.length, 0);
});

for (const [path, body, code, state] of [
  ["profiles/service", { action: "connect" }, "central_invalid_request", "written"],
  ["profiles/service", { action: "connect" }, "central_invalid", "written"],
  ["skill-installations", { files: [] }, "skill_invalid_package", "installed"],
  ["skill-installations", { files: [] }, "skill_invalid", "installed"],
  ["skill-installations", { files: [] }, "central_invalid_request", "installed"],
]) test("confirmed " + code + " input rejection on " + path + " permits an explicit correction", async t => {
  let rejected = true;
  const api = client(t, () => rejected ? Response.json({ error: { code, operation_state: "not_started" } }, { status: 400 }) : Response.json(successReceipt(path, state)));
  await assert.rejects(api.request(path, body));
  assert.equal(api.requests.length, 1, "Do not retry automatically");
  assert.equal(api.refreshRequired(), false);
  rejected = false;
  assert.equal((await api.request(path, body)).state, state);
  assert.equal(api.requests.length, 2);
});

for (const [status, code, operationState] of [
  [400, "central_invalid", "unknown"], [400, "central_invalid", undefined],
  [400, "unrecognized", "not_started"], [403, "central_invalid", "not_started"],
  [409, "central_revision_conflict", "not_started"], [503, "central_invalid", "not_started"],
]) test("input correction does not bypass refresh after " + status + " " + code + " " + operationState, async t => {
  const api = client(t, () => Response.json({ error: { code, operation_state: operationState } }, { status }));
  await assert.rejects(api.request("profiles/service", { action: "connect" }));
  assert.equal(api.refreshRequired(), true);
  await assert.rejects(api.request("profiles/service", { action: "connect" }), /refreshTheLibraryBeforeMakingAnotherChange/u);
  assert.equal(api.requests.length, 1);
});

for (const locale of ['en', 'zh-CN']) test('confirmed Skill capacity rejection keeps the ' + locale + ' form usable', async t => {
  const translate = createCentralTranslator(locale);
  let full = true;
  const api = client(t, () => full
    ? Response.json({ error: { code: 'skill_capacity', operation_state: 'not_started' } }, { status: 429 })
    : Response.json(installedSkill), translate);
  await assert.rejects(api.request('skill-installations', { files: [], expected_revision: 32 }), {
    message: translate('skillLibraryLimitReached'),
  });
  assert.equal(api.refreshRequired(), false);
  assert.equal(api.requests.length, 1, 'The rejected installation is never replayed');
  full = false;
  assert.equal((await api.request('skill-installations', { files: [], expected_revision: 0 })).state, 'installed');
  assert.equal(api.requests.length, 2);
});

for (const [path, code, operationState] of [
  ['skill-installations', 'skill_capacity', 'unknown'],
  ['skill-installations', 'skill_capacity', undefined],
  ['skill-installations', 'central_revision_conflict', 'not_started'],
  ['skill-installations', 'central_result_unconfirmed', 'not_started'],
  ['skills/research', 'skill_capacity', 'not_started'],
]) test('capacity recovery remains scoped to a confirmed installation: ' + path + ' ' + code + ' ' + operationState, async t => {
  const api = client(t, () => Response.json({ error: { code, operation_state: operationState } }, { status: 429 }));
  await assert.rejects(api.request(path, { files: [], expected_revision: 32 }), /operationCouldNotBeConfirmedRefreshTheCurrentState/u);
  assert.equal(api.refreshRequired(), true);
  await assert.rejects(api.request('skill-installations', { files: [], expected_revision: 0 }), /refreshTheLibraryBeforeMakingAnotherChange/u);
  assert.equal(api.requests.length, 1);
});

for (const detached of [false, true]) test("request timeout preserves " + (detached ? "detached-view cancellation" : "service-local recovery"), async t => {
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => schedule(callback, delay === 25000 ? 0 : delay));
  const api = client(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const pending = api.request("discovery/service", {});
  if (detached) api.detach();
  await assert.rejects(pending, detached ? { name: "AbortError" } : {
    name: "Error", message: "connectionInterruptedRefreshToCheckWhetherTheOperationCompleted",
  });
  assert.equal(api.refreshRequired(), true);
  assert.equal(api.requests.length, 1);
  await assert.rejects(api.request("discovery/service", {}), detached ? { name: "AbortError" } : /refreshTheLibraryBeforeMakingAnotherChange/u);
  assert.equal(api.requests.length, 1);
});

test("detaching during a pending response prevents a follow-up mutation", async t => {
  const response = deferred();
  const api = client(t, () => response.promise);
  const pending = api.request("profiles/service", { action: "connect" }).then(() => api.request("profiles/service", { action: "enable" }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  api.detach(); response.resolve(Response.json({ state: "written" }));
  await rejected;
  assert.equal(api.requests.length, 1);
  assert.equal(api.refreshRequired(), true);
});

for (const [path, body] of [["profiles", undefined], ["connections/begin", { profile_id: "service" }]])
test("a late " + path + " response releases its unread body after navigation", async t => {
  const headers = deferred();
  let controller, pulls = 0, cancellations = 0, settled = false;
  const stream = new ReadableStream({
    start(value) { controller = value; },
    pull() { pulls++; },
    cancel() { cancellations++; },
  }, { highWaterMark: 0 });
  const api = client(t, () => headers.promise);
  const pending = api.request(path, body);
  const rejected = assert.rejects(pending, { name: "AbortError" }).then(() => { settled = true; });
  api.detach();
  headers.resolve(new Response(stream, { headers: { "content-type": "application/json" } }));
  await new Promise(setImmediate);
  const observed = { pulls, cancellations, settled };
  // Finish an uncancelled stream as well, so a regression never leaves a live
  // request deadline behind or waits for the production 25-second timeout.
  if (!cancellations) controller.close();
  await rejected;
  assert.deepEqual(observed, { pulls: 0, cancellations: 1, settled: true });
  assert.equal(api.refreshRequired(), body !== undefined);
  assert.equal(api.requests.length, 1);
});

test("detaching while a response body is pending prevents consuming the receipt", async t => {
  const body = deferred(), entered = deferred();
  const api = client(t, () => ({ ok: true, status: 200, json: () => { entered.resolve(); return body.promise; } }));
  const pending = api.request("connections/begin", {});
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered.promise; api.detach(); body.resolve({ state: "started", authorization_url: "https://provider.example/authorize" });
  await rejected;
  assert.equal(api.requests.length, 1);
  assert.equal(api.refreshRequired(), true);
});

test("collection pagination remains bounded to the current view", async t => {
  const response = deferred();
  const api = client(t, () => response.promise);
  const pending = api.list("profiles");
  const rejected = assert.rejects(pending, { name: "AbortError" });
  api.detach(); response.resolve(Response.json({ state: "listed", profiles: [], next_after: "page-2" }));
  await rejected;
  assert.equal(api.requests.length, 1);
});

const lifecycleDigests = ["a", "b", "c", "d"].map(value => value.repeat(64));
const lifecycleHead = { skill_id: "research", revision: 7, staged_digest: lifecycleDigests[1], active_digest: lifecycleDigests[0], enabled: true };
const lifecycleCapacity = { skill_bytes: 4096, skill_versions: 4, library_bytes: 8192, library_skills: 2, max_versions: 32, max_library_bytes: 268435456, max_skills: 1000 };
const lifecycleHistory = { state: "listed", head: lifecycleHead, capacity: lifecycleCapacity, versions: lifecycleDigests.map((digest, index) => ({ digest, bytes: 1024, file_count: 2,
  created_at_ms: index ? null : 1000, active: index === 0, staged: index === 1, pinned: index === 2,
  summary: { name: "Research", description: "Team notes", source: "Local", license: "MIT" } })) };
const lifecycleFingerprint = "f".repeat(64);
const lifecyclePlan = () => ({ fingerprint: lifecycleFingerprint, skill_id: "research", revision: 7, digests: [lifecycleDigests[3]], bytes: 1024, expires_at_ms: Date.now() + 300000 });

function centralDomFixture(t, locale = "en") {
  function element(tag = "div") {
    const attributes = new Map();
    const node = { tag, children: [], hidden: false, textContent: "", disabled: false, isConnected: true,
      append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
      ...fixtureEventMethods(),
      setAttribute(name, value) { attributes.set(name, String(value)); }, getAttribute(name) { return attributes.get(name) ?? null; },
      focus() { document.activeElement = this; }, scrollIntoView() {}, classList: { toggle() {} } };
    return node;
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { documentElement: { lang: locale }, createElement: element } });
  t.after(() => original ? Object.defineProperty(globalThis, "document", original) : delete globalThis.document);
  return { element };
}

for (const failedCollection of ["profiles", "skills"]) for (const sibling of ["success", "failure", "retired page"])
test("Library refresh retains its pending " + sibling + " read after " + failedCollection + " fails", async t => {
  const { element } = centralDomFixture(t);
  const app = element(), refresh = element("button"), status = element(), serviceForm = element("form");
  const serviceList = element(), skillList = element();
  const elements = { "[data-product-status]": status, "[data-product-refresh]": refresh,
    "[data-service-create]": serviceForm, "[data-service-list]": serviceList, "[data-skill-list]": skillList };
  app.setAttribute("data-skills", "true");
  app.querySelector = selector => elements[selector] ?? null;
  app.querySelectorAll = selector => selector === "button,input,select" ? [refresh] : [];
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://worker.test/admin/central" } });
  t.after(() => previousLocation ? Object.defineProperty(globalThis, "location", previousLocation) : delete globalThis.location);
  const pending = deferred(), requests = [];
  let refreshing = false, current = true;
  const listed = collection => Response.json({ state: "listed", [collection]: [], next_after: null });
  t.mock.method(globalThis, "fetch", async path => {
    const collection = path.split("/").at(-1);
    requests.push(collection);
    if (!refreshing) return listed(collection);
    if (collection === failedCollection) return Response.json({ error: { code: "central_authority_unavailable", operation_state: "not_started" } }, { status: 503 });
    await pending.promise;
    return sibling === "failure" ? Response.json({ error: { code: "central_denied", operation_state: "not_started" } }, { status: 403 }) : listed(collection);
  });
  bindCentralProduct({ querySelector: () => app }, { isCurrent: () => current, navigate() {}, replaceCurrentUrl() {} });
  await new Promise(setImmediate);
  assert.equal(refresh.disabled, false);
  refreshing = true;
  refresh.dispatch("click");
  await new Promise(setImmediate);
  const pendingStatus = status.textContent;
  try {
    assert.equal(refresh.disabled, true, "A failed collection cannot release the other collection's pending refresh");
    assert.equal(app.getAttribute("aria-busy"), "true");
    refresh.dispatch("click");
    await new Promise(setImmediate);
    assert.deepEqual(requests, ["profiles", "skills", "profiles", "skills"], "Another refresh cannot queue redundant collection reads");
  } finally {
    if (sibling === "retired page") current = false;
    pending.resolve();
    await new Promise(setImmediate);
  }
  assert.equal(refresh.disabled, false);
  assert.equal(app.getAttribute("aria-busy"), "false");
  if (sibling === "retired page") {
    assert.equal(status.textContent, pendingStatus, "Settled reads cannot update the status of a retired page");
    assert.equal(status.getAttribute("data-error"), "false");
    return;
  }
  assert.equal(status.getAttribute("data-error"), "true", "The successful sibling cannot replace the failure with an up-to-date message");
  assert.equal(status.textContent, createCentralTranslator("en")("sessionVerificationUnavailable"), "The first failure is retained when the other collection also fails");
  refreshing = false;
  refresh.dispatch("click");
  await new Promise(setImmediate);
  assert.equal(status.getAttribute("data-error"), "false");
  assert.equal(status.textContent, "List refreshed.");
});

function oauthHandoffFixture(t, send = async () => undefined, read = async () => {}) {
  const { element } = centralDomFixture(t), list = element(), panel = element(), status = element(), form = element('form');
  form.elements = { endpoint: { value: 'https://created.example/mcp' }, authentication: { value: 'oauth' }, name: { value: 'Created', maxLength: 64 } };
  form.reset = () => {};
  const profiles = ['a', 'b'].map(id => ({ profile_id: id, connector_id: id, display_name: id, endpoint: 'https://' + id + '.example/mcp',
    authentication: 'oauth', enabled: true, revision: 1 }));
  const app = { querySelector: selector => ({ '[data-service-list]': list, '[data-service-tools]': panel,
    '[data-product-status]': status, '[data-service-create]': form })[selector] ?? null };
  const errors = [], requests = [], destinations = [];
  let pending, refreshes = 0;
  const run = action => {
    pending = Promise.resolve().then(action).catch(error => { errors.push(error); });
    return pending;
  };
  const view = createCentralView(app, createCentralTranslator('en'), run);
  const workflow = createServiceWorkflow({ app, view, t: createCentralTranslator('en'), run, getProfiles: () => profiles,
    navigate: url => destinations.push(url),
    refresh: async () => { await read(++refreshes); workflow.render(profiles); return profiles; },
    api: async (path, body) => {
      requests.push({ path, body });
      const supplied = await send(path, body);
      if (supplied !== undefined) return supplied;
      if (path === 'connections/begin') return { state: 'started', authorization_url: 'https://' + body.profile_id + '.example/authorize' };
      if (path.startsWith('catalogs/')) return null;
      if (path.startsWith('discovery/')) return { state: 'authorization_required' };
      const id = path.split('/')[1];
      if (body.action === 'connect') profiles.push({ ...body, profile_id: id, enabled: false, revision: 1 });
      const profile = profiles.find(item => item.profile_id === id);
      if (body.action === 'enable') { profile.enabled = true; profile.revision++; }
      return { state: 'written', profile };
    } });
  workflow.render(profiles);
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  return { profiles, requests, errors, destinations, status, render: () => workflow.render(profiles),
    click(id, label) {
      const card = list.children.find(item => item.children.some(child => child.tag === 'h3' && child.textContent === id));
      const button = nodes(card).find(node => node.tag === 'button' && node.textContent === label);
      assert.ok(button, label + ' exists for ' + id); button.dispatch('click'); return pending;
    },
    create() { form.dispatch('submit', { preventDefault() {}, currentTarget: form }); return pending; } };
}

for (const result of ['older-first', 'newer-first', 'older-fails', 'newer-fails'])
  test('OAuth keeps the latest connection intent when ' + result, async t => {
    const waits = new Map(['a', 'b'].map(id => [id, deferred()])), entered = new Map(['a', 'b'].map(id => [id, deferred()]));
    const ui = oauthHandoffFixture(t, async (path, body) => {
      if (path !== 'connections/begin') return;
      const id = body.profile_id; entered.get(id).resolve(); await waits.get(id).promise;
      if (result === 'older-fails' && id === 'a' || result === 'newer-fails' && id === 'b') throw new Error(id + ' failed');
    });
    const a = ui.click('a', 'Reconnect'); await entered.get('a').promise;
    const b = ui.click('b', 'Reconnect'); await entered.get('b').promise;
    if (result === 'newer-first' || result === 'newer-fails') { waits.get('b').resolve(); await b; waits.get('a').resolve(); await a; }
    else { waits.get('a').resolve(); await a; assert.deepEqual(ui.destinations, []); waits.get('b').resolve(); await b; }
    assert.deepEqual(ui.destinations, result === 'newer-fails' ? [] : ['https://b.example/authorize']);
    assert.deepEqual(ui.errors.map(error => error.message), result === 'newer-fails' ? ['b failed'] : []);
    assert.equal(ui.requests.filter(request => request.path === 'connections/begin').length, 2);
    if (result === 'newer-fails') {
      await ui.click('a', 'Reconnect');
      assert.deepEqual(ui.destinations, ['https://a.example/authorize'], 'A fresh user retry can claim the handoff after the latest attempt failed');
    }
  });

test('OAuth replacement during profile reconciliation prevents the older begin request', async t => {
  const entered = deferred(), waiting = deferred();
  const ui = oauthHandoffFixture(t, undefined, async count => { if (count === 1) { entered.resolve(); await waiting.promise; } });
  const a = ui.click('a', 'Reconnect'); await entered.promise;
  await ui.click('b', 'Reconnect'); waiting.resolve(); await a;
  assert.deepEqual(ui.requests.filter(request => request.path === 'connections/begin').map(request => request.body.profile_id), ['b']);
  assert.deepEqual(ui.destinations, ['https://b.example/authorize']);
});

for (const action of ['Refresh tools', 'Enable', 'create'])
  test('OAuth intent precedes the first asynchronous step of ' + action, async t => {
    const entered = deferred(), waiting = deferred(), began = deferred(), beginWait = deferred();
    const ui = oauthHandoffFixture(t, async (path, body) => {
      if (path === 'connections/begin' && body.profile_id === 'b') { began.resolve(); await beginWait.promise; }
      if (action === 'Refresh tools' && path === 'discovery/a'
        || action === 'Enable' && path === 'profiles/a'
        || action === 'create' && body?.action === 'connect') { entered.resolve(); await waiting.promise; }
    });
    if (action === 'Enable') { ui.profiles[0].enabled = false; ui.render(); }
    const older = action === 'create' ? ui.create() : ui.click('a', action); await entered.promise;
    const latest = ui.click('b', 'Reconnect'); await began.promise;
    waiting.resolve(); await older;
    assert.deepEqual(ui.requests.filter(request => request.path === 'connections/begin').map(request => request.body.profile_id), ['b']);
    assert.deepEqual(ui.destinations, []);
    beginWait.resolve(); await latest;
    assert.deepEqual(ui.destinations, ['https://b.example/authorize']);
    assert.deepEqual(ui.errors, []);
  });

test('Viewing another MCP does not cancel an explicit OAuth handoff', async t => {
  const entered = deferred(), waiting = deferred();
  const ui = oauthHandoffFixture(t, async path => { if (path === 'connections/begin') { entered.resolve(); await waiting.promise; } });
  const pending = ui.click('a', 'Reconnect'); await entered.promise;
  await ui.click('b', 'View tools'); waiting.resolve(); await pending;
  assert.deepEqual(ui.destinations, ['https://a.example/authorize']);
});

function skillSelectionFixture(t, locale = "en", selected = lifecycleDigests[1]) {
  const { element } = centralDomFixture(t, locale);
  const list = element(), review = element(), history = element(), status = element();
  const app = { querySelector: selector => ({ "[data-skill-list]": list, "[data-skill-review]": review,
    "[data-skill-history]": history, "[data-product-status]": status })[selector] ?? null, querySelectorAll: () => [review, history] };
  const head = { skill_id: "research", revision: 1, active_digest: selected, staged_digest: lifecycleDigests[1], enabled: selected !== null };
  const bundles = lifecycleDigests.slice(0, 2).map((digest, index) => ({ skill_id: head.skill_id, digest,
    name: "Research", description: "Research version " + (index + 1), source: "local", license: "MIT", files: [{ path: "SKILL.md", text: "Instructions version " + (index + 1) }] }));
  const library = () => [{ head: structuredClone(head), summary: bundles.find(bundle => bundle.digest === (head.active_digest ?? head.staged_digest)) }];
  let pending;
  const run = action => { pending = Promise.resolve().then(action); };
  const view = createCentralView(app, createCentralTranslator(locale), run), requests = [];
  const api = async (path, body) => {
    requests.push({ path, body });
    if (path.endsWith("/versions")) return { state: "listed", head: structuredClone(head), capacity: { ...lifecycleCapacity, skill_versions: 2 },
      versions: bundles.map(bundle => ({ digest: bundle.digest, bytes: 1024, file_count: 1, created_at_ms: null, pinned: false,
        active: bundle.digest === head.active_digest, staged: bundle.digest === head.staged_digest, summary: bundle })) };
    if (body) {
      assert.equal(body.expected_revision, head.revision);
      assert.ok(["activate", "disable"].includes(body.action));
      if (body.action === "activate") { assert.ok(bundles.some(bundle => bundle.digest === body.digest)); head.active_digest = body.digest; }
      head.enabled = body.action === "activate"; head.revision++;
      return { state: "written", head: structuredClone(head) };
    }
    const digest = new URL(path, "https://worker.test/").searchParams.get("digest") ?? head.staged_digest;
    return { state: "found", head: structuredClone(head), bundle: bundles.find(bundle => bundle.digest === digest) };
  };
  const workflow = createSkillWorkflow({ app, api, view, t: createCentralTranslator(locale), run, getSkills: library,
    refresh: async () => { view.invalidate(); workflow.render(library()); } });
  workflow.render(library());
  const nodes = node => [node, ...node.children.flatMap(nodes)], translate = createCentralTranslator(locale);
  const buttons = (panel, key) => nodes(panel).filter(node => node.tag === "button" && node.textContent === translate(key));
  return { list, review, history, head, requests, nodes, buttons,
    click: async (panel, key) => { const button = buttons(panel, key)[0]; assert.ok(button, key + " is available"); button.dispatch("click"); return pending; } };
}

for (const locale of ["en", "zh-CN"]) test("Restored Skill selection survives pause and resume before an explicit latest upload update in " + locale, async t => {
  const ui = skillSelectionFixture(t, locale);
  await ui.click(ui.list, "skillHistory");
  await ui.click(ui.history, "restoreSkillVersion");
  await ui.click(ui.history, "confirm");
  assert.equal(ui.head.active_digest, lifecycleDigests[0]);
  assert.equal(ui.head.staged_digest, lifecycleDigests[1]);
  assert.ok(ui.nodes(ui.list).some(node => node.textContent === "Research version 1"));
  await ui.click(ui.list, "pause");
  assert.equal(ui.head.enabled, false);
  assert.equal(ui.buttons(ui.list, "viewLatestUpload").length, 1, "A paused selection still exposes its separate latest upload");
  await ui.click(ui.list, "viewFiles");
  assert.equal(ui.requests.at(-1).path, "skills/research?digest=" + lifecycleDigests[0]);
  assert.ok(ui.nodes(ui.review).some(node => node.tag === "pre" && node.textContent === "Instructions version 1"));
  await ui.click(ui.review, "enableSkill");
  assert.equal(ui.head.enabled, true);
  assert.equal(ui.head.active_digest, lifecycleDigests[0], "Resuming retains the restored version");
  assert.equal(ui.head.staged_digest, lifecycleDigests[1]);
  await ui.click(ui.list, "viewLatestUpload");
  assert.equal(ui.requests.at(-1).path, "skills/research?digest=" + lifecycleDigests[1]);
  assert.ok(ui.nodes(ui.review).some(node => node.tag === "pre" && node.textContent === "Instructions version 2"));
  assert.equal(ui.head.active_digest, lifecycleDigests[0], "Reviewing the upload is read-only");
  await ui.click(ui.review, "publishUpdate");
  assert.equal(ui.head.active_digest, lifecycleDigests[1]);
  assert.equal(ui.buttons(ui.list, "viewLatestUpload").length, 0);
  assert.deepEqual(ui.requests.filter(request => request.body?.action === "activate").map(request => request.body.digest), [lifecycleDigests[0], lifecycleDigests[0], lifecycleDigests[1]]);
});

test("A Skill without a selected active version opens its staged files for first activation", async t => {
  const ui = skillSelectionFixture(t, "en", null);
  assert.equal(ui.buttons(ui.list, "viewLatestUpload").length, 0, "A first upload has one file entry point");
  await ui.click(ui.list, "viewFiles");
  assert.equal(ui.requests.at(-1).path, "skills/research?digest=" + lifecycleDigests[1]);
  await ui.click(ui.review, "enableSkill");
  assert.equal(ui.head.active_digest, lifecycleDigests[1]);
  assert.equal(ui.head.enabled, true);
});

function skillHistoryFixture(t, send = () => undefined, locale = "en", afterRefresh = () => {}) {
  const { element } = centralDomFixture(t, locale);
  const panel = element(), status = element();
  panel.hidden = true;
  const app = { querySelector: selector => ({ "[data-skill-history]": panel, "[data-product-status]": status })[selector] ?? null,
    querySelectorAll: () => [panel] };
  let pending, refreshed = 0;
  const view = createCentralView(app, createCentralTranslator(locale), action => { pending = Promise.resolve().then(action); });
  const requests = [], inspections = [];
  const snapshot = structuredClone(lifecycleHistory);
  const api = async (path, body) => {
    requests.push({ path, body });
    const result = await send(path, body);
    if (result !== undefined) return result;
    if (path.endsWith("/versions")) return structuredClone(snapshot);
    if (path.endsWith("/cleanup-preview")) return { state: "previewed", plan: lifecyclePlan() };
    if (path.endsWith("/cleanup")) return { state: "cleaned", deleted_digests: [lifecycleDigests[3]], freed_bytes: 1024 };
    if (path.endsWith("/retention")) {
      snapshot.versions.find(version => version.digest === body.digest).pinned = body.pinned;
      snapshot.head.revision++;
      return { state: "retained", head: snapshot.head, digest: body.digest, pinned: body.pinned };
    }
    if (body?.action === "activate") { snapshot.head.active_digest = body.digest; snapshot.head.enabled = true; snapshot.head.revision++; }
    return { state: "written" };
  };
  const history = createSkillHistory({ app, api, view, t: createCentralTranslator(locale), getSkills: () => [{ head: snapshot.head }],
    refresh: async () => { refreshed++; view.invalidate(); afterRefresh(snapshot); },
    inspect: async (id, digest) => { inspections.push({ id, digest }); } });
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  const buttons = label => nodes(panel).filter(node => node.tag === "button" && node.textContent === label);
  return { panel, status, history, view, requests, inspections, nodes, buttons, refreshed: () => refreshed,
    select: () => { const checkbox = nodes(panel).find(node => node.tag === "input"); checkbox.checked = true; checkbox.dispatch("change"); return checkbox; },
    click: async button => { button.dispatch("click"); return pending; } };
}

for (const locale of ["en", "zh-CN"]) test("Skill version history renders capacity and only offers eligible cleanup in " + locale, async t => {
  const ui = skillHistoryFixture(t, undefined, locale);
  await ui.history.open("research", "Research");
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.nodes(ui.panel).filter(node => node.tag === "input").length, 1, "Active, latest and kept versions have no cleanup selector");
  assert.ok(ui.nodes(ui.panel).some(node => node.textContent.includes("4 / 32")));
  assert.equal(document.activeElement.tag, "h2", "Opening history moves keyboard focus to its heading");
  assert.equal(ui.requests.length, 1, "History loads metadata without fetching file bodies");
});

for (const locale of ["en", "zh-CN"]) test("Skill history preserves literal replacement characters in user names in " + locale, async t => {
  const ui = skillHistoryFixture(t, undefined, locale);
  for (const name of ["Research $& notes", "Research $` notes", "Research $' notes", "Research {count} notes"]) {
    await ui.history.open("research", name);
    const heading = ui.nodes(ui.panel).find(node => node.tag === "h2");
    assert.equal(heading.textContent, name + (locale === "en" ? " · Version history" : " · 版本记录"));
  }
});

test("Skill cleanup previews an exact selection and writes only after confirmation", async t => {
  const ui = skillHistoryFixture(t);
  await ui.history.open("research", "Research");
  ui.select();
  await ui.click(ui.buttons("Preview cleanup")[0]);
  assert.deepEqual(ui.requests.at(-1), { path: "skills/research/cleanup-preview", body: { digests: [lifecycleDigests[3]], expected_revision: 7 } });
  assert.equal(ui.requests.filter(request => request.path.endsWith("/cleanup")).length, 0);
  assert.equal(document.activeElement.textContent, "Clean up selected versions");
  await ui.click(ui.buttons("Confirm")[0]);
  assert.deepEqual(ui.requests.find(request => request.path.endsWith("/cleanup")), { path: "skills/research/cleanup", body: { fingerprint: lifecycleFingerprint, expected_revision: 7, confirm: true } });
  assert.equal(ui.refreshed(), 1);
  assert.match(ui.status.textContent, /Versions cleaned up/u);
});

for (const reason of ["refresh", "selection", "expired", "failed"]) test("Skill cleanup drops old confirmation after " + reason, async t => {
  const ui = skillHistoryFixture(t, (path) => {
    if (reason === "expired" && path.endsWith("/cleanup-preview")) return { state: "previewed", plan: { ...lifecyclePlan(), expires_at_ms: 1 } };
    if (reason === "failed" && path.endsWith("/cleanup")) throw new Error("network failed");
  });
  await ui.history.open("research", "Research");
  const checkbox = ui.select();
  await ui.click(ui.buttons("Preview cleanup")[0]);
  const oldConfirm = ui.buttons("Confirm")[0];
  if (reason === "refresh") ui.view.invalidate();
  if (reason === "selection") { checkbox.checked = false; checkbox.dispatch("change"); }
  await assert.rejects(ui.click(oldConfirm));
  await assert.rejects(ui.click(oldConfirm));
  assert.equal(ui.requests.filter(request => request.path.endsWith("/cleanup")).length, reason === "failed" ? 1 : 0, "No retry or stale confirmation can issue a second cleanup");
  assert.equal(ui.panel.hidden, true);
});

test("Skill pin and restore use the current revision and restore requires confirmation", async t => {
  const ui = skillHistoryFixture(t);
  await ui.history.open("research", "Research");
  await ui.click(ui.buttons("Keep version")[0]);
  assert.deepEqual(ui.requests.find(request => request.path.endsWith("/retention")), { path: "skills/research/retention", body: { digest: lifecycleDigests[0], pinned: true, expected_revision: 7 } });
  await ui.click(ui.buttons("Use this version")[0]);
  assert.equal(ui.requests.some(request => request.body?.action === "activate"), false);
  await ui.click(ui.buttons("Confirm")[0]);
  assert.deepEqual(ui.requests.find(request => request.body?.action === "activate"), { path: "skills/research", body: { action: "activate", expected_revision: 8, digest: lifecycleDigests[1] } });
});

for (const change of ["paused", "replaced"]) test("Skill restore does not announce success after a concurrent " + change + " state", async t => {
  const ui = skillHistoryFixture(t, undefined, "en", snapshot => {
    snapshot.head.revision++;
    if (change === "paused") snapshot.head.enabled = false;
    else snapshot.head.active_digest = lifecycleDigests[2];
  });
  await ui.history.open("research", "Research");
  await ui.click(ui.buttons("Use this version")[0]);
  await assert.rejects(ui.click(ui.buttons("Confirm")[0]), /The Skill has changed/u);
  assert.equal(ui.requests.filter(request => request.body?.action === "activate").length, 1);
  assert.equal(ui.refreshed(), 1);
  assert.notEqual(ui.status.textContent, "Active version updated.");
  assert.equal(ui.panel.hidden, true);
});

for (const pin of [true, false]) test("Skill retention confirms the refreshed " + (pin ? "kept" : "cleanup") + " state", async t => {
  const selected = pin ? lifecycleDigests[0] : lifecycleDigests[2];
  const ui = skillHistoryFixture(t, undefined, "en", snapshot => {
    snapshot.head.revision++;
    snapshot.versions.find(version => version.digest === selected).pinned = !pin;
  });
  await ui.history.open("research", "Research");
  await assert.rejects(ui.click(ui.buttons(pin ? "Keep version" : "Unpin version")[0]), /Version history has changed/u);
  assert.equal(ui.requests.filter(request => request.path.endsWith("/retention")).length, 1);
  assert.equal(ui.refreshed(), 1);
  assert.notEqual(ui.status.textContent, pin ? "Version kept." : "Version unpinned.");
  assert.equal(ui.panel.hidden, true);
});

for (const locale of ["en", "zh-CN"]) for (const version of [0, 1])
test("Unpinning the " + (version === 0 ? "active" : "latest") + " Skill version preserves cleanup protection in " + locale, async t => {
  const ui = skillHistoryFixture(t, undefined, locale);
  const translate = createCentralTranslator(locale);
  const card = () => ui.nodes(ui.panel).find(node => node.tag === "article" && node.children[0].textContent === lifecycleDigests[version].slice(0, 12));
  const action = label => ui.nodes(card()).find(node => node.tag === "button" && node.textContent === translate(label));
  await ui.history.open("research", "Research");
  await ui.click(action("pinSkillVersion"));
  await ui.click(action("unpinSkillVersion"));
  assert.equal(ui.status.textContent, locale === "en" ? "Version unpinned." : "已取消保留。");
  assert.equal(ui.nodes(card()).some(node => node.tag === "input"), false, "The active and latest versions remain protected after their pin is removed");
  assert.equal(ui.requests.filter(request => request.path.endsWith("/retention")).length, 2);
  assert.equal(action("pinSkillVersion").disabled, false, "The refreshed version can be kept again");
});

test("Skill cleanup preview rejects a non-digest fingerprint", async t => {
  const api = client(t, () => Response.json({ state: "previewed", plan: { ...lifecyclePlan(), fingerprint: "not-a-digest" } }));
  await assert.rejects(api.request("skills/research/cleanup-preview", { digests: [lifecycleDigests[3]], expected_revision: 7 }), unexpected);
  assert.equal(api.refreshRequired(), false);
});

test("Skill diff shows truncated excerpts with full-version file actions", async t => {
  const ui = skillHistoryFixture(t, (path, body) => path.endsWith("/compare") ? { state: "compared", skill_id: "research", revision: 7,
    before: body.before, after: body.after, files: [{ path: "SKILL.md", change: "modified", before_bytes: 20000, after_bytes: 30000,
      before_text: "before", after_text: "<script>untrusted</script>", truncated: true }], metadata: [{ field: "license", before: "MIT", after: "ISC" }], truncated: true } : undefined);
  await ui.history.open("research", "Research");
  await ui.click(ui.buttons("Compare versions")[0]);
  assert.ok(ui.nodes(ui.panel).some(node => node.tag === "pre" && node.textContent === "<script>untrusted</script>"));
  assert.ok(ui.nodes(ui.panel).some(node => node.textContent.startsWith("Showing an excerpt")));
  await ui.click(ui.buttons("View after files")[0]);
  assert.deepEqual(ui.inspections, [{ id: "research", digest: lifecycleDigests[1] }]);
});

test("Skill lifecycle read-only requests do not admit malformed receipts or poison write admission", async t => {
  const api = client(t, () => Response.json({ state: "previewed", plan: { ...lifecyclePlan(), digests: [lifecycleDigests[2]] } }));
  await assert.rejects(api.request("skills/research/cleanup-preview", { digests: [lifecycleDigests[3]], expected_revision: 7 }), unexpected);
  assert.equal(api.refreshRequired(), false);
});

test("Skill lifecycle uncertain cleanup requires refresh and never replays", async t => {
  const api = client(t, () => Response.json({ state: "cleaned", skill_id: "research", head: lifecycleHead, deleted_digests: [lifecycleDigests[3]], freed_bytes: 1024, capacity: lifecycleCapacity }));
  const body = { fingerprint: lifecycleFingerprint, expected_revision: 7, confirm: true };
  await assert.rejects(api.request("skills/research/cleanup", body), unexpected);
  assert.equal(api.refreshRequired(), true);
  await assert.rejects(api.request("skills/research/cleanup", body), /refreshTheLibrary/u);
  assert.equal(api.requests.length, 1);
});

test("Skill lifecycle accepts complete operation-specific receipts", async t => {
  const cases = [
    ["versions", undefined, lifecycleHistory],
    ["compare", { before: lifecycleDigests[0], after: lifecycleDigests[1] }, { state: "compared", skill_id: "research", revision: 7, before: lifecycleDigests[0], after: lifecycleDigests[1], files: [], metadata: [], truncated: false }],
    ["retention", { digest: lifecycleDigests[2], pinned: false, expected_revision: 7 }, { state: "retained", head: { ...lifecycleHead, revision: 8 }, digest: lifecycleDigests[2], pinned: false }],
    ["cleanup-preview", { digests: [lifecycleDigests[3]], expected_revision: 7 }, { state: "previewed", plan: lifecyclePlan() }],
    ["cleanup", { fingerprint: lifecycleFingerprint, expected_revision: 7, confirm: true }, { state: "cleaned", skill_id: "research", head: { ...lifecycleHead, revision: 8 }, deleted_digests: [lifecycleDigests[3]], freed_bytes: 1024, capacity: lifecycleCapacity }],
  ];
  let index = 0;
  const api = client(t, () => Response.json(cases[index++][2]));
  for (const [path, body, receipt] of cases) assert.deepEqual(await api.request("skills/research/" + path, body), receipt);
  assert.equal(api.refreshRequired(), false);
});

const skillSource = { repository: "https://github.com/example/skills", commit: "a".repeat(40), path: "skills/research" };
const sourceBundle = { schema_version: 1, skill_id: "research", name: "Research", description: "Team notes", digest: lifecycleDigests[3], source: skillSource.repository + "/tree/" + skillSource.commit + "/" + skillSource.path,
  license: "MIT", files: [{ path: "SKILL.md", text: "# Research" }] };
const sourcePreview = { state: "previewed", source: skillSource, bundle: sourceBundle };

function skillSourceFixture(t, send = () => undefined) {
  const { element } = centralDomFixture(t);
  const form = element("form"), panel = element(), status = element(), limits = element();
  form.elements = Object.fromEntries(Object.entries(skillSource).map(([key, value]) => [key, Object.assign(element("input"), { value })]));
  form.dataset = { maxFiles: "32" };
  let pending, skills = [], refreshed = 0;
  const run = action => { pending = Promise.resolve().then(action); };
  const app = { querySelector: selector => ({ "[data-skill-source]": form, "[data-skill-source-preview]": panel, "[data-product-status]": status, "[data-skill-source-limits]": limits })[selector] ?? null,
    querySelectorAll: () => [panel] };
  const view = createCentralView(app, createCentralTranslator("en"), run);
  const requests = [];
  bindSkillSource({ app, view, t: createCentralTranslator("en"), run, getSkills: () => skills,
    refresh: async () => { refreshed++; view.invalidate(); }, openHistory: async () => {},
    api: async (path, body) => {
      requests.push({ path, body });
      const result = await send(path, body);
      if (result !== undefined) return result;
      if (path.endsWith("/preview")) return sourcePreview;
      const head = { ...lifecycleHead, revision: 1, active_digest: sourceBundle.digest, staged_digest: sourceBundle.digest };
      skills = [{ head, summary: { name: sourceBundle.name } }];
      return { state: "written", head };
    } });
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  return { form, panel, view, status, requests, limits, refreshed: () => refreshed,
    button: label => nodes(panel).find(node => node.tag === "button" && node.textContent === label),
    submit: async () => { form.dispatch("submit"); return pending; }, click: async node => { node.dispatch("click"); return pending; } };
}

test("GitHub Skill import previews the exact commit and waits for an explicit install", async t => {
  const ui = skillSourceFixture(t);
  await ui.submit();
  assert.deepEqual(ui.requests, [{ path: "skill-source/preview", body: { source: skillSource, expected_revision: 0 } }]);
  assert.match(ui.limits.textContent, /32 text files/u);
  assert.equal(document.activeElement.textContent, "Research");
  await ui.click(ui.button("Install Skill"));
  assert.deepEqual(ui.requests[1], { path: "skill-source/install", body: { source: skillSource, expected_revision: 0, digest: sourceBundle.digest } });
  assert.equal(ui.refreshed(), 1);
  assert.equal(ui.status.textContent, "Research installed.");
});

for (const reason of ["input", "refresh", "failure"]) test("GitHub import invalidates its prior confirmation after " + reason, async t => {
  const ui = skillSourceFixture(t, path => { if (reason === "failure" && path.endsWith("/install")) throw new Error("changed source"); });
  await ui.submit();
  const confirm = ui.button("Install Skill");
  if (reason === "input") { ui.form.elements.commit.value = "b".repeat(40); ui.form.elements.commit.dispatch("input"); }
  if (reason === "refresh") ui.view.invalidate();
  await assert.rejects(ui.click(confirm));
  await assert.rejects(ui.click(confirm));
  assert.equal(ui.requests.filter(request => request.path.endsWith("/install")).length, reason === "failure" ? 1 : 0);
  assert.equal(ui.panel.hidden, true);
});

test("GitHub preview receipt stays bound to the requested commit", async t => {
  const api = client(t, () => Response.json({ ...sourcePreview, source: { ...skillSource, commit: "b".repeat(40) } }));
  await assert.rejects(api.request("skill-source/preview", { source: skillSource, expected_revision: 0 }), unexpected);
  assert.equal(api.refreshRequired(), false);
});

test("GitHub install receipt must confirm the reviewed digest and next revision", async t => {
  const api = client(t, () => Response.json({ state: "written", head: { ...lifecycleHead, revision: 1 } }));
  const body = { source: skillSource, expected_revision: 0, digest: sourceBundle.digest };
  await assert.rejects(api.request("skill-source/install", body), unexpected);
  assert.equal(api.refreshRequired(), true);
  await assert.rejects(api.request("skill-source/install", body), /refreshTheLibrary/u);
  assert.equal(api.requests.length, 1);
});

test("Skill cleanup reconciles an unexpected deleted set without reporting success or replaying", async t => {
  const ui = skillHistoryFixture(t, path => path.endsWith("/cleanup") ? { state: "cleaned", deleted_digests: [lifecycleDigests[2]], freed_bytes: 1024 } : undefined);
  await ui.history.open("research", "Research");
  ui.select();
  await ui.click(ui.buttons("Preview cleanup")[0]);
  const confirm = ui.buttons("Confirm")[0];
  await assert.rejects(ui.click(confirm), /Unexpected response/u);
  assert.equal(ui.refreshed(), 1, "A completed cleanup is reconciled even when its receipt disagrees with the preview");
  await assert.rejects(ui.click(confirm));
  assert.equal(ui.requests.filter(request => request.path.endsWith("/cleanup")).length, 1);
  assert.doesNotMatch(ui.status.textContent, /Versions cleaned up/u);
});

test("GitHub source requests use the server-derived time budget", async t => {
  const timeouts = [];
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, delay) => { timeouts.push(delay); return timeout(fn, delay); });
  t.mock.method(globalThis, "fetch", async () => Response.json(sourcePreview));
  const api = createCentralApi({ csrf: "csrf", t: key => key, isCurrent: () => true, refreshRequired: () => false, requireRefresh() {}, sourceTimeoutMs: 27000 });
  await api.request("skill-source/preview", { source: skillSource, expected_revision: 0 });
  assert.deepEqual(timeouts, [27000]);
});

const inspectedService = { state: "inspected", endpoint: "https://public.example/mcp", server: { protocol_version: "2025-11-25",
  capabilities: { tools: true, resources: true, prompts: false, tasks: true, apps: false } }, tools_count: 4, observed_at_ms: 1000 };

test("MCP connection check follows the enabled state through refresh and busy controls", async t => {
  const { element } = centralDomFixture(t);
  const status = element(), form = element("form"), refresh = element("button"), list = element(), panel = element(), app = element();
  form.elements = { endpoint: Object.assign(element("input"), { value: inspectedService.endpoint }), authentication: Object.assign(element("select"), { value: "none" }) };
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  app.getAttribute = name => name === "data-skills" ? "false" : "fixture-csrf";
  app.querySelector = selector => ({ "[data-product-status]": status, "[data-service-create]": form, "[data-product-refresh]": refresh,
    "[data-service-list]": list, "[data-service-inspection]": panel })[selector] ?? null;
  app.querySelectorAll = selector => selector === "button,input,select"
    ? [refresh, ...Object.values(form.elements), ...nodes(list).filter(node => node.tag === "button")]
    : selector.startsWith("[data-service-tools]") ? [panel] : [];
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://worker.test/admin/central" } });
  t.after(() => previousLocation ? Object.defineProperty(globalThis, "location", previousLocation) : delete globalThis.location);
  const profile = { profile_id: "service", connector_id: "service", display_name: "Example", endpoint: inspectedService.endpoint, enabled: false, authentication: "oauth", revision: 1 };
  let readGate;
  const inspectionGate = deferred(), requests = [];
  t.mock.method(globalThis, "fetch", async (path, options) => {
    requests.push({ path, body: options.body && JSON.parse(options.body) });
    if (path.endsWith("/profiles")) {
      if (readGate) await readGate.promise;
      return Response.json({ state: "listed", profiles: [profile], next_after: null });
    }
    if (path.endsWith("/connection-check")) { await inspectionGate.promise; return Response.json(inspectedService); }
    assert.fail("Unexpected request " + path);
  });
  bindCentralProduct({ querySelector: () => app }, { isCurrent: () => true, navigate() {}, replaceCurrentUrl() {} });
  const check = () => nodes(list).find(node => node.tag === "button" && node.textContent === "Check connection");
  await new Promise(setImmediate);
  assert.equal(check().disabled, true, "A paused MCP does not offer a failing inspection");
  profile.enabled = true; profile.revision++; readGate = deferred();
  refresh.dispatch("click"); await new Promise(setImmediate);
  assert.equal(refresh.disabled, true);
  assert.equal(check().disabled, true);
  readGate.resolve(); await new Promise(setImmediate);
  assert.equal(refresh.disabled, false);
  assert.equal(check().disabled, false, "Refreshed enabled state unlocks inspection");
  check().dispatch("click"); await new Promise(setImmediate);
  assert.equal(check().disabled, true, "Inspection participates in the controller busy lock");
  inspectionGate.resolve(); await new Promise(setImmediate);
  assert.equal(check().disabled, false);
  assert.deepEqual(requests.filter(request => request.path.endsWith("/connection-check")), [{ path: "/admin/central/connection-check", body: { profile_id: "service" } }]);
  profile.enabled = false; profile.revision++;
  refresh.dispatch("click"); await new Promise(setImmediate);
  assert.equal(refresh.disabled, false);
  assert.equal(check().disabled, true, "The paused state survives the refresh busy lock being released");
});

function serviceInspectionFixture(t, send = () => inspectedService) {
  const { element } = centralDomFixture(t);
  const panel = element(), form = element("form"), trigger = element("button"), status = element();
  form.elements = { endpoint: Object.assign(element("input"), { value: inspectedService.endpoint }), authentication: Object.assign(element("select"), { value: "none" }) };
  let pending;
  const app = { querySelector: selector => ({ "[data-service-inspection]": panel, "[data-service-create]": form, "[data-service-check]": trigger, "[data-product-status]": status })[selector] ?? null,
    querySelectorAll: () => [panel] };
  const run = action => { pending = Promise.resolve().then(action); };
  const view = createCentralView(app, createCentralTranslator("en"), run);
  const requests = [];
  const inspection = createServiceInspection({ app, view, t: createCentralTranslator("en"), run,
    api: async (path, body) => { requests.push({ path, body }); return send(path, body); } });
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  return { panel, form, status, view, inspection, requests, nodes,
    check: async () => { trigger.dispatch("click"); return pending; } };
}

test("MCP connection check reads tool availability and labels other capabilities as declarations", async t => {
  const ui = serviceInspectionFixture(t);
  await ui.check();
  assert.deepEqual(ui.requests, [{ path: "connection-check", body: { endpoint: inspectedService.endpoint } }]);
  const copy = ui.nodes(ui.panel).map(node => node.textContent);
  assert.ok(copy.includes("Tool list checked · 4 tools"));
  assert.ok(copy.includes("Resources · Declared by the service"));
  assert.ok(copy.includes("Tasks · Declared by the service"));
  assert.equal(document.activeElement.textContent, "Connection check");
  assert.equal(ui.form.elements.authentication.value, "none", "Inspection keeps the ordinary Connect form unchanged");
});

test("MCP connection check uses existing profile identity and provides OAuth guidance", async t => {
  const ui = serviceInspectionFixture(t, () => ({ state: "authorization_required" }));
  await ui.inspection.inspect({ profile_id: "service" });
  assert.deepEqual(ui.requests, [{ path: "connection-check", body: { profile_id: "service" } }]);
  assert.match(ui.status.textContent, /Select Reconnect/u);
  await ui.check();
  assert.match(ui.status.textContent, /Select OAuth and connect/u);
});

test("MCP connection check clears old and pending results when its endpoint changes", async t => {
  const response = deferred();
  const ui = serviceInspectionFixture(t, () => response.promise);
  const pending = ui.check();
  await new Promise(setImmediate);
  ui.form.elements.endpoint.value = "https://other.example/mcp";
  ui.form.elements.endpoint.dispatch("input");
  response.resolve(inspectedService);
  await pending;
  assert.equal(ui.panel.hidden, true);
  assert.equal(ui.panel.children.length, 0);
});

test("MCP inspection invalidation follows the displayed connection or draft", async t => {
  const ui = serviceInspectionFixture(t);
  await ui.inspection.inspect({ profile_id: 'selected' });
  const content = ui.panel.children.slice();
  ui.view.invalidate('mcp:unrelated');
  assert.deepEqual(ui.panel.children, content);
  ui.form.elements.endpoint.dispatch('input');
  assert.deepEqual(ui.panel.children, content, 'Editing the connection form preserves a saved MCP inspection');
  ui.view.invalidate('mcp:selected');
  assert.equal(ui.panel.hidden, true); assert.equal(ui.panel.children.length, 0);
  await ui.check();
  ui.view.invalidate('mcp:selected');
  assert.equal(ui.panel.hidden, false, 'A draft inspection belongs to the form');
  ui.view.invalidate('mcp-create');
  assert.equal(ui.panel.children.length, 0);
});

test("A late tool read cannot replace a later selection, and unrelated invalidation keeps that selection", async t => {
  const { element } = centralDomFixture(t), list = element(), panel = element(), status = element(), form = element('form');
  const app = { querySelector: selector => ({ '[data-service-list]': list, '[data-service-tools]': panel,
    '[data-product-status]': status, '[data-service-create]': form })[selector] ?? null };
  const selected = deferred(), finished = [], nodes = node => [node, ...node.children.flatMap(nodes)];
  const run = action => { const operation = Promise.resolve().then(action); finished.push(operation); return operation; };
  const view = createCentralView(app, key => key, run);
  const catalog = id => ({ head: { approved_digest: id, approved_names: [] }, snapshot: { digest: id, tools: [] } });
  const workflow = createServiceWorkflow({ app, view, t: key => key, run, refresh() {}, navigate() {},
    api: async path => path === 'catalogs/a' ? selected.promise : catalog('b') });
  workflow.render(['a', 'b'].map(id => ({ profile_id: id, display_name: id, endpoint: 'https://' + id + '.example/mcp', enabled: true })));
  const buttons = nodes(list).filter(node => node.tag === 'button' && node.textContent === 'viewTools');
  buttons[0].dispatch('click'); await new Promise(setImmediate);
  buttons[1].dispatch('click'); await finished[1];
  const contents = panel.children.slice();
  assert.ok(nodes(panel).some(node => node.tag === 'h2' && node.textContent === 'b'));
  view.invalidate('mcp:a'); assert.deepEqual(panel.children, contents);
  selected.resolve(catalog('a')); await finished[0];
  assert.deepEqual(panel.children, contents, 'The old response still settles without displaying stale tools');
  view.invalidate('mcp:b'); assert.equal(panel.hidden, true); assert.equal(panel.children.length, 0);
});

test("MCP inspection accepts inspected and authorization receipts without mutating the library", async t => {
  let count = 0;
  const api = client(t, () => Response.json(count++ ? { state: "authorization_required" } : inspectedService));
  assert.deepEqual(await api.request("connection-check", { endpoint: inspectedService.endpoint }), inspectedService);
  assert.deepEqual(await api.request("connection-check", { profile_id: "service" }), { state: "authorization_required" });
  assert.equal(api.refreshRequired(), false);
});

for (const result of [{ state: "written" }, { ...inspectedService, tools_count: null }, { ...inspectedService, server: { capabilities: {} } }])
test("MCP inspection rejects incomplete results while keeping normal connection available " + JSON.stringify(result.server), async t => {
  const api = client(t, () => Response.json(result));
  await assert.rejects(api.request("connection-check", { endpoint: inspectedService.endpoint }), unexpected);
  assert.equal(api.refreshRequired(), false);
});

test("Registry preview admits configuration-only metadata without claiming a usable connection", async t => {
  const preview = { state: "previewed", name: "example/mcp", version: "1.0.0", description: "A service", schema: null,
    remotes: [{ endpoint: "http://localhost:8080/mcp", transport: "sse", mode: "configure", headers: ["Authorization"] }],
    packages: [{ registry: "npm", identifier: "example-mcp", version: "1.0.0" }], digest: lifecycleDigests[0], observed_at_ms: 1000 };
  const api = client(t, () => Response.json(preview));
  assert.deepEqual(await api.request("registry-preview", { entry: {} }), preview);
  assert.equal(api.refreshRequired(), false);
});

test("Registry invalid entry and malformed receipts remain read-only failures", async t => {
  let count = 0;
  const api = client(t, () => count++ ? Response.json({ state: "previewed" }) : Response.json({ error: { code: "registry_invalid_entry", operation_state: "not_started" } }, { status: 400 }));
  await assert.rejects(api.request("registry-preview", { entry: {} }), /registryInvalidEntry/u);
  await assert.rejects(api.request("registry-preview", { entry: {} }), unexpected);
  assert.equal(api.refreshRequired(), false);
});

const registryPreview = { state: "previewed", name: "example/team-mcp", version: "1.0.0", description: "<script>metadata</script>", schema: null,
  remotes: [{ endpoint: "https://registry.example/mcp", transport: "streamable-http", mode: "connect", headers: [] },
    { endpoint: "https://configured.example/mcp", transport: "streamable-http", mode: "configure", headers: ["Authorization"] }],
  packages: [{ registry: "npm", identifier: "team-mcp", version: "1.0.0" }], digest: lifecycleDigests[0], observed_at_ms: 1000 };

function registryFixture(t, send = () => registryPreview) {
  const { element } = centralDomFixture(t);
  const panel = element("details"), picker = element("input"), result = element(), previewButton = element("button"), form = element("form"), status = element(), inspectionPanel = element();
  const entry = { name: "example/team-mcp", version: "1.0.0", remotes: [{ type: "streamable-http", url: "https://registry.example/mcp" }] };
  const bytes = new TextEncoder().encode(JSON.stringify(entry));
  picker.files = [{ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }];
  panel.dataset = { maxBytes: "262144" };
  panel.querySelector = selector => ({ "[data-registry-file]": picker, "[data-registry-results]": result, "[data-registry-preview]": previewButton })[selector] ?? null;
  form.elements = { endpoint: Object.assign(element("input"), { value: "https://old.example/mcp" }), authentication: Object.assign(element("select"), { value: "oauth" }), name: Object.assign(element("input"), { value: "Old name", maxLength: 64 }) };
  const app = { querySelector: selector => ({ "[data-registry-import]": panel, "[data-service-create]": form, "[data-product-status]": status, "[data-service-inspection]": inspectionPanel })[selector] ?? null,
    querySelectorAll: () => [inspectionPanel] };
  let pending;
  const run = action => { pending = Promise.resolve().then(action); };
  const view = createCentralView(app, createCentralTranslator("en"), run);
  const requests = [];
  const api = async (path, body) => { requests.push({ path, body }); return path === "connection-check" ? inspectedService : send(path, body); };
  const inspection = createServiceInspection({ app, api, view, t: createCentralTranslator("en"), run });
  bindRegistryImport({ app, api, view, t: createCentralTranslator("en"), run });
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  return { form, panel, picker, result, inspectionPanel, inspection, requests, view, entry, nodes,
    buttons: () => nodes(result).filter(node => node.tag === "button"),
    preview: async () => { previewButton.dispatch("click"); return pending; }, click: async node => { node.dispatch("click"); return pending; } };
}

test("Registry preview only reads metadata; choosing a candidate fills Connect and clears prior inspection", async t => {
  const ui = registryFixture(t);
  await ui.inspection.inspect({ endpoint: ui.form.elements.endpoint.value });
  assert.equal(ui.inspectionPanel.hidden, false);
  await ui.preview();
  assert.deepEqual(ui.requests.at(-1), { path: "registry-preview", body: { entry: ui.entry } });
  assert.equal(ui.form.elements.endpoint.value, "https://old.example/mcp", "Preview itself must not change the ordinary Connect form");
  assert.equal(ui.buttons().length, 1, "Only a direct candidate offers form fill");
  assert.ok(ui.nodes(ui.result).some(node => node.textContent === "<script>metadata</script>"), "Registry description is rendered as text");
  await ui.click(ui.buttons()[0]);
  assert.equal(ui.form.elements.endpoint.value, "https://registry.example/mcp");
  assert.equal(ui.form.elements.authentication.value, "none");
  assert.equal(ui.form.elements.name.value, "example/team-mcp");
  assert.equal(ui.inspectionPanel.hidden, true, "Filling the endpoint dispatches input and invalidates old inspection");
  assert.equal(ui.requests.length, 2, "The candidate button never starts a profile write, OAuth flow, or second network request");
});

test("Registry input preserves workflow invalidation alongside ordered event observers", async t => {
  const ui = registryFixture(t), input = ui.form.elements.endpoint, observed = [];
  await ui.inspection.inspect({ endpoint: input.value });
  await ui.preview();
  const candidate = ui.buttons()[0];
  const receivers = [];
  function first() { receivers.push(this); observed.push('first'); }
  function second() { receivers.push(this); observed.push('second'); }
  input.addEventListener('input', first);
  input.addEventListener('input', first);
  input.addEventListener('input', second);
  await ui.click(candidate);
  assert.deepEqual(observed, ['first', 'second'], 'Distinct callbacks run in registration order; the same callback runs once');
  assert.ok(receivers.every(receiver => receiver === input), 'Listeners receive their element as this');
  assert.equal(ui.inspectionPanel.hidden, true, 'An observer must not overwrite the real workflow invalidation listener');
  input.removeEventListener('input', first);
  await ui.inspection.inspect({ endpoint: input.value });
  await ui.click(candidate);
  assert.deepEqual(observed, ['first', 'second', 'second']);
  assert.equal(ui.inspectionPanel.hidden, true, 'Removing one observer preserves both the workflow and the other observer');
  assert.equal(ui.requests.filter(request => request.path === 'registry-preview').length, 1);
});

for (const reason of ["file", "refresh"]) test("Registry prior candidate is invalidated by " + reason, async t => {
  const ui = registryFixture(t);
  await ui.preview();
  const candidate = ui.buttons()[0];
  if (reason === "file") ui.picker.dispatch("change"); else ui.view.invalidate();
  await ui.click(candidate);
  assert.equal(ui.result.children.length, 0);
  assert.equal(ui.form.elements.endpoint.value, "https://old.example/mcp");
  assert.equal(ui.requests.length, 1);
});

test("Registry candidates survive another MCP's failure and expire with their own form", async t => {
  const ui = registryFixture(t);
  await ui.preview();
  const candidate = ui.buttons()[0];
  ui.view.invalidate('mcp:another');
  assert.equal(ui.buttons()[0], candidate);
  await ui.click(candidate);
  assert.equal(ui.form.elements.endpoint.value, 'https://registry.example/mcp');
  await ui.preview();
  const stale = ui.buttons()[0];
  ui.view.invalidate('mcp-create');
  assert.equal(ui.result.children.length, 0);
  const endpoint = ui.form.elements.endpoint.value;
  await ui.click(stale);
  assert.equal(ui.form.elements.endpoint.value, endpoint);
});

test("Registry package metadata is displayed without install or execution controls", async t => {
  const ui = registryFixture(t, () => ({ ...registryPreview, remotes: [] }));
  await ui.preview();
  assert.equal(ui.buttons().length, 0);
  assert.ok(ui.nodes(ui.result).some(node => node.textContent === "npm · team-mcp · 1.0.0"));
  assert.ok(ui.nodes(ui.result).some(node => node.textContent === "Host these packages, then connect their HTTPS endpoint."));
  assert.deepEqual(ui.requests.map(request => request.path), ["registry-preview"]);
});

test("Registry pending preview is dropped when another file is selected", async t => {
  const response = deferred();
  const ui = registryFixture(t, () => response.promise);
  const pending = ui.preview();
  await new Promise(setImmediate);
  ui.picker.dispatch("change");
  response.resolve(registryPreview);
  await pending;
  assert.equal(ui.result.children.length, 0);
  assert.equal(ui.buttons().length, 0);
});

for (const trigger of ["refresh", "uncertain write"]) test("Invalidation reaches only the affected workflow once after " + trigger, async t => {
  const { element } = centralDomFixture(t);
  const nodes = node => [node, ...node.children.flatMap(nodes)];
  const panelNames = ["service-tools", "service-inspection", "skill-review", "skill-history", "skill-source-preview", "registry-results"];
  const panels = Object.fromEntries(panelNames.map(name => [name, element()]));
  const status = element(), refresh = element("button"), serviceList = element(), skillList = element(), app = element();
  const serviceForm = element("form"), check = element("button"), sourceForm = element("form"), registry = element("details"), picker = element("input"), preview = element("button");
  const field = (tag, value) => Object.assign(element(tag), { value });
  serviceForm.elements = { endpoint: field("input", inspectedService.endpoint), authentication: field("select", "none"), name: Object.assign(field("input", "Example"), { maxLength: 64 }) };
  sourceForm.elements = Object.fromEntries(Object.entries(skillSource).map(([key, value]) => [key, field("input", value)]));
  sourceForm.dataset = { maxFiles: "32" };
  const registryBytes = new TextEncoder().encode('{"name":"example/team-mcp","version":"1.0.0"}');
  picker.files = [{ size: registryBytes.byteLength, arrayBuffer: async () => registryBytes.buffer }];
  registry.dataset = { maxBytes: "262144" };
  registry.querySelector = selector => ({ "[data-registry-file]": picker, "[data-registry-results]": panels["registry-results"], "[data-registry-preview]": preview })[selector] ?? null;
  const elements = { "[data-product-status]": status, "[data-product-refresh]": refresh, "[data-service-list]": serviceList, "[data-skill-list]": skillList,
    "[data-service-create]": serviceForm, "[data-service-check]": check, "[data-skill-source]": sourceForm, "[data-registry-import]": registry,
    ...Object.fromEntries(panelNames.map(name => ["[data-" + name + "]", panels[name]])) };
  const attributes = new Map([["data-skills", "true"], ["data-csrf", "fixture-csrf"], ["data-source-timeout-ms", "27000"]]);
  app.getAttribute = name => attributes.get(name);
  app.setAttribute = (name, value) => attributes.set(name, value);
  app.querySelector = selector => elements[selector] ?? null;
  app.querySelectorAll = selector => selector === "button,input,select"
    ? [...new Set([refresh, check, picker, preview, ...Object.values(serviceForm.elements), ...Object.values(sourceForm.elements),
      ...[serviceList, skillList, ...Object.values(panels)].flatMap(nodes).filter(node => ["button", "input", "select"].includes(node.tag))])]
    : selector.split(",").map(value => elements[value]).filter(Boolean);
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://worker.test/admin/central" } });
  t.after(() => previousLocation ? Object.defineProperty(globalThis, "location", previousLocation) : delete globalThis.location);
  const requests = [], profile = { profile_id: "service", connector_id: "service", display_name: "Example", endpoint: inspectedService.endpoint, enabled: false, authentication: "none", revision: 1 };
  t.mock.method(globalThis, "fetch", async (path, options) => {
    const url = new URL(path, "https://worker.test"), route = url.pathname.slice("/admin/central/".length), body = options.body && JSON.parse(options.body);
    requests.push({ route, body });
    if (route === "profiles") return Response.json({ state: "listed", profiles: [profile], next_after: null });
    if (route === "skills") return Response.json({ state: "listed", skills: [{ head: lifecycleHead, summary: sourceBundle }], next_after: null });
    if (route === "catalogs/service") return Response.json({ state: "found", head: { revision: 1, approved_digest: lifecycleDigests[0], approved_names: [] }, snapshot: { digest: lifecycleDigests[0], tools: [] } });
    if (route === "connection-check") return Response.json(inspectedService);
    if (route === "skills/research/versions") return Response.json(lifecycleHistory);
    if (route === "skills/research" && !body) return Response.json({ state: "found", head: lifecycleHead, bundle: { ...sourceBundle, digest: url.searchParams.get("digest") } });
    if (route === "skill-source/preview") return Response.json(sourcePreview);
    if (route === "registry-preview") return Response.json(registryPreview);
    if (route === "skills/research" && body.action === "disable") return Response.json({ error: { code: "central_result_unconfirmed", operation_state: "unknown" } }, { status: 503 });
    assert.fail("Unexpected request " + route);
  });
  const bind = () => bindCentralProduct({ querySelector: () => app }, { isCurrent: () => true, navigate() {}, replaceCurrentUrl() {} });
  bind(); bind();
  await new Promise(setImmediate);
  assert.equal(requests.filter(request => request.route === "profiles").length, 1, "Binding the page again does not register another workflow");
  const click = async button => { assert.ok(button); button.dispatch("click"); await new Promise(setImmediate); };
  const action = (panel, label) => nodes(panel).find(node => node.tag === "button" && node.textContent === label);
  await click(action(serviceList, "View tools"));
  await click(check);
  await click(action(skillList, "View files"));
  await click(action(skillList, "Version history"));
  sourceForm.dispatch("submit", { preventDefault() {}, currentTarget: sourceForm }); await new Promise(setImmediate);
  await click(preview);
  const stale = [action(panels["skill-history"], "Keep version"), action(panels["skill-source-preview"], "Update Skill"), action(panels["registry-results"], "Use this connection")];
  for (const button of stale) assert.ok(button);
  const clearCalls = new Map();
  for (const panel of Object.values(panels)) {
    assert.ok(panel.children.length > 0, "The regression opens each real workflow panel before invalidating it");
    clearCalls.set(panel, t.mock.method(panel, "replaceChildren"));
  }
  await click(trigger === "refresh" ? refresh : action(skillList, "Pause"));
  assert.equal(app.getAttribute("aria-busy"), "false");
  for (const [name, panel] of Object.entries(panels)) {
    if (trigger === "uncertain write" && !name.startsWith("skill-")) {
      assert.equal(clearCalls.get(panel).mock.callCount(), 0, "An uncertain Skill write preserves " + name);
      assert.ok(panel.children.length > 0);
      continue;
    }
    assert.equal(clearCalls.get(panel).mock.callCount(), 1, name + " has one invalidation owner");
    assert.equal(panel.children.length, 0);
    if (name !== "registry-results") assert.equal(panel.hidden, true);
    assert.equal(nodes(panel).some(node => stale.includes(node)), false, "Stale actions are removed from the displayed DOM");
  }
  const afterInvalidation = requests.length, endpoint = serviceForm.elements.endpoint.value;
  for (const button of trigger === "refresh" ? stale : stale.slice(0, 2)) await click(button);
  assert.equal(requests.length, afterInvalidation, "Old history/source actions cannot send another request after invalidation");
  assert.equal(serviceForm.elements.endpoint.value, endpoint, "An old Registry candidate cannot fill the form after invalidation");
});
