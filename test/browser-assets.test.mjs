import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildBrowserSource, browserModule, writeBrowserAssets } from "../scripts/generate-browser-assets.mjs";
import { adminScript } from "../apps/worker/dist/admin/client-script.js";
import { oauthLanding } from "../apps/worker/dist/http/oauth-landing.js";

async function oauthCallbackReceipt(status, error, query = "state=fixture&code=fixture", locale = "en", csrf = true) {
  const page = await oauthLanding(locale).text();
  const decode = value => value.replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
  const dataset = Object.fromEntries([...page.matchAll(/data-([a-z]+)="([^"]*)"/gu)].map(([, key, value]) => [key, decode(value)]));
  const message = {}, title = {}, attributes = new Map(), requests = [], navigations = [], scrubbed = [];
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(page)[1];
  const cookieName = /v.startsWith\('([^']+)='/u.exec(script)[1];
  await runInNewContext(script, {
    document: { cookie: csrf ? cookieName + "=fixture" : "", getElementById: id => id === "status" ? message : title,
      querySelector: () => ({ dataset, setAttribute: (key, value) => attributes.set(key, value) }) },
    window: { addEventListener() {} }, URLSearchParams, AbortSignal,
    history: { replaceState: (...args) => scrubbed.push(args[2]) },
    location: { search: "?" + query, replace: path => navigations.push(path) },
    fetch: async (path, init) => { requests.push({ path, body: JSON.parse(init.body) }); return Response.json({ error }, { status }); },
  });
  return { message: message.textContent, dataset, attributes, requests, navigations, scrubbed };
}

for (const locale of ["en", "zh-CN"]) for (const [status, code, kind] of [
  [403, "central_admin_denied", "session"], [400, "oauth_invalid_callback", "expired"],
  [503, "oauth_configuration_required", "configuration"], [503, "oauth_provider_unsupported", "provider"],
  [503, "oauth_reauthorization_required", "restart"], [409, "oauth_conflict", "changed"],
  [403, "oauth_denied", "denied"], [503, "central_authority_unavailable", "unavailable"],
]) test(`OAuth callback preserves ${code} guidance (${locale})`, async () => {
  const result = await oauthCallbackReceipt(status, { code, operation_state: "not_started", message: "PRIVATE_PROVIDER_DETAIL" }, undefined, locale);
  assert.equal(typeof result.dataset[kind], "string");
  assert.equal(result.message, result.dataset[kind]);
  assert.equal(result.attributes.get("aria-busy"), "false");
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.navigations, []);
  assert.deepEqual(result.scrubbed, ["/admin/central/connections/callback"]);
  assert.equal(result.message.includes("PRIVATE_PROVIDER_DETAIL"), false);
});

for (const [status, code, state] of [
  [503, "oauth_configuration_required", "unknown"], [503, "oauth_unavailable", "unknown"],
  [503, "private-provider-code", "not_started"], [503, "oauth_invalid_callback", "not_started"],
  [403, "central_admin_denied", undefined],
]) test(`OAuth callback retains an unconfirmed result for ${status}/${code}/${state}`, async () => {
  const result = await oauthCallbackReceipt(status, { code, operation_state: state }, "state=fixture&error=access_denied");
  assert.equal(result.message, result.dataset.unconfirmed);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.navigations, []);
});

test("OAuth callback confirms cancellation only from its completed rejection receipt", async () => {
  const result = await oauthCallbackReceipt(503, { code: "oauth_reauthorization_required", operation_state: "not_started" },
    "state=fixture&error=access_denied&error_description=PRIVATE_PROVIDER_DETAIL");
  assert.equal(result.message, result.dataset.cancelled);
  assert.deepEqual(result.requests, [{ path: "/admin/central/connections/complete", body: { state: "fixture", error: "access_denied" } }]);
  assert.deepEqual(result.navigations, []);
});

test("OAuth callback requests a fresh session when its CSRF cookie is absent, without posting the code", async () => {
  const result = await oauthCallbackReceipt(503, {}, undefined, "en", false);
  assert.equal(result.message, result.dataset.session);
  assert.equal(result.requests.length, 0);
  assert.deepEqual(result.navigations, []);
});

test("OAuth callback rejects duplicate authorization fields before posting", async () => {
  const result = await oauthCallbackReceipt(503, {}, "state=one&state=two&code=fixture");
  assert.equal(result.message, result.dataset.restart);
  assert.equal(result.requests.length, 0);
});

test("local browser modules preserve the reviewed rendered script hashes", async () => {
  const baseline = JSON.parse(await readFile(new URL("fixtures/admin-client-baseline.json", import.meta.url), "utf8"));
  const source = await buildBrowserSource(fileURLToPath(new URL("../", import.meta.url)));
  const generated = browserModule(source);
  assert.equal(generated, await readFile(new URL("../apps/worker/src/generated-admin-client.ts", import.meta.url), "utf8"));
  for (const { nonce, sha256 } of baseline.cases) {
    assert.equal(createHash("sha256").update(adminScript(nonce ?? undefined)).digest("hex"), sha256);
  }
});

async function browserFixture(t, sources) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps/worker/src"), { recursive: true });
  const directory = join(root, "apps/worker/browser");
  for (const [name, source] of Object.entries(sources)) {
    const path = join(directory, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, source);
  }
  return root;
}

test("browser bundling is deterministic across roots and does not execute DOM code", async t => {
  const sources = {
    "admin-client.js": 'import { bind } from "./central/controller.js"; bind(document);',
    "central/controller.js": 'export function bind(root) { throw new Error(root.title); }',
  };
  const first = await browserFixture(t, sources), second = await browserFixture(t, sources);
  const source = await buildBrowserSource(first);
  assert.equal(source, await buildBrowserSource(second));
  assert.equal(source, await buildBrowserSource(first));
  assert.doesNotThrow(() => browserModule(source));
  await writeBrowserAssets(first);
  assert.equal(await readFile(join(first, "apps/worker/src/generated-admin-client.ts"), "utf8"), browserModule(source));
});

for (const [name, entry, dependency] of [
  ["external packages", 'import "third-party";', {}],
  ["parent source escape", 'import "../outside.js";', { "../outside.js": "console.log('outside');" }],
  ["dynamic imports", 'import("./lazy.js");', { "lazy.js": "console.log('lazy');" }],
  ["computed dynamic imports", 'const path = location.hash; import(path);', {}],
  ["CommonJS imports", 'require("./lazy.js");', { "lazy.js": "console.log('lazy');" }],
  ["computed CommonJS imports", 'const path = location.hash; require(path);', {}],
]) {
  test("browser bundler rejects " + name, async t => {
    const root = await browserFixture(t, { "admin-client.js": entry, ...dependency });
    await assert.rejects(buildBrowserSource(root), /invalid_browser_dependency/u);
  });
}

test("browser bundler rejects oversized dependency graphs before writing output", async t => {
  const root = await browserFixture(t, {
    "admin-client.js": 'import "./large.js";\n/*' + "a".repeat(70 * 1024) + '*/',
    "large.js": '/*' + "b".repeat(70 * 1024) + '*/',
  });
  await assert.rejects(writeBrowserAssets(root), /invalid_browser_source/u);
  await assert.rejects(readFile(join(root, "apps/worker/src/generated-admin-client.ts")), { code: "ENOENT" });
});

test("browser bundler rejects symlink dependencies", async t => {
  const root = await browserFixture(t, {
    "admin-client.js": 'import "./alias/module.js";',
    "real/module.js": "console.log('linked');",
  });
  const directory = join(root, "apps/worker/browser");
  await symlink(join(directory, "real"), join(directory, "alias"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(buildBrowserSource(root), /invalid_browser_dependency/u);
});
test("browser syntax checking never executes the source", () => {
  assert.doesNotThrow(() => browserModule('throw new Error("must not execute");'));
  assert.throws(() => browserModule("function {"));
  assert.throws(() => browserModule("x".repeat(128 * 1024 + 1)));
  assert.throws(() => browserModule("</" + "script>"));
});
