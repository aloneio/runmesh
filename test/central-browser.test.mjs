import assert from "node:assert/strict";
import { test } from "node:test";
import { createCentralApi } from "../apps/worker/browser/central/api.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function client(t, send) {
  let current = true, refresh = false;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (...args) => { requests.push(args); return send(...args); });
  const api = createCentralApi({ csrf: "fixture-csrf", t: key => key, isCurrent: () => current,
    refreshRequired: () => refresh, requireRefresh: () => { refresh = true; } });
  return { ...api, requests, detach: () => { current = false; }, refreshRequired: () => refresh };
}
const unexpected = /unexpectedResponseRefreshBeforeMakingAnotherChange/u;

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

test("a detached view cannot start reads previews or writes", async t => {
  const api = client(t, () => { throw new Error("No network request expected"); });
  api.detach();
  for (const body of [undefined, { action: "preview" }, { action: "enable" }])
    await assert.rejects(api.request("profiles/service", body), { name: "AbortError" });
  assert.equal(api.requests.length, 0);
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
