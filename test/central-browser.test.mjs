import assert from "node:assert/strict";
import { test } from "node:test";
import { createCentralApi } from "../apps/worker/browser/central/api.js";
import { createCentralTranslator } from "../apps/worker/browser/central/messages.js";

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
  const api = client(t, () => Response.json({ state: cases[index++][2] }));
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

test("missing catalog remains an explicit optional read", async t => {
  const api = client(t, () => Response.json({ error: { code: "central_missing" } }, { status: 404 }));
  assert.equal(await api.request("catalogs/service", undefined, true), null);
  await assert.rejects(api.request("catalogs/service"), /operationCouldNotBeConfirmedRefreshTheCurrentState/u);
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
  const api = client(t, () => rejected ? Response.json({ error: { code, operation_state: "not_started" } }, { status: 400 }) : Response.json({ state }));
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
