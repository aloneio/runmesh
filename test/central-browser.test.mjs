import assert from "node:assert/strict";
import { test } from "node:test";
import { createCentralApi } from "../apps/worker/browser/central/api.js";
import { createCentralTranslator } from "../apps/worker/browser/central/messages.js";
import { bindCentralProduct } from "../apps/worker/browser/central/controller.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
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
    const events = new Map();
    return { isConnected: true, disabled: false, textContent: "", style: {}, children: [],
      addEventListener: (name, action) => events.set(name, action), dispatch(name, event) { events.get(name)?.(event); },
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
    if (options.method === "GET") { reads++; return Response.json({ state: "listed", profiles, next_after: null }); }
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
  assert.equal(reads, 2, "The existing explicit refresh remains available to reconcile the committed create");
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

for (const locale of ["en", "zh-CN"]) test("OAuth deployment configuration failures give specific " + locale + " guidance", async t => {
  const translate = createCentralTranslator(locale);
  const api = client(t, () => Response.json({ error: { code: "oauth_configuration_required", operation_state: "not_started" } }, { status: 503 }), translate);
  await assert.rejects(api.request("connections/begin", { profile_id: "service", expected_revision: 1 }), { message: translate("oauthConfigurationRequired") });
  assert.equal(api.requests.length, 1);
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
  await assert.rejects(api.list("profiles", "profiles"), unexpected);
});

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
  const pending = api.list("profiles", "profiles");
  const rejected = assert.rejects(pending, { name: "AbortError" });
  api.detach(); response.resolve(Response.json({ state: "listed", profiles: [], next_after: "page-2" }));
  await rejected;
  assert.equal(api.requests.length, 1);
});
