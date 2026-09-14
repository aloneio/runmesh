import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../apps/worker/src/index.ts", import.meta.url), "utf8");
function extract(name, next) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf(`\nfunction ${next}(`, start);
  assert.ok(start > 0 && end > start); return source.slice(start, end);
}
const load = extract("loadAdminPage", "bindFeatureAlert");
const mount = extract("mountAdminPage", "loadAdminPage");
function harness() {
  const fetched = [], mounted = [];
  const main = { setAttribute() {}, removeAttribute() {} };
  const context = {
    URL, window: {}, location: { href: "https://worker.test/admin" },
    document: { querySelector: () => main }, console: { error() {} },
    pageKey: (url) => url.pathname + url.search, ensurePageViewport: () => ({}), pageRoot: (node) => node,
    // A legacy cached entry is deliberately present. It must never bypass fetch.
    cachedPage: () => { throw new Error("stale cache consulted"); },
    fetch: async (url, options) => { fetched.push({ url, options }); return { ok: true, text: async () => `version-${fetched.length}` }; },
    DOMParser: class { parseFromString(markup) { return { title: markup, querySelector: () => ({ markup }) }; } },
    mountAdminPage: (root, title, key, viewport, push, url) => mounted.push({ root, title, key, push, url: url.href }),
  };
  vm.createContext(context); vm.runInContext(load, context);
  return { context, fetched, mounted, open: (path, push = true) => context.loadAdminPage(new URL(path, context.location.href), push) };
}

test("revisiting and explicitly refreshing a cached URL performs fresh no-store reads", async () => {
  const h = harness(); await h.open("/admin", false); await h.open("/admin", false);
  assert.equal(h.fetched.length, 2); assert.deepEqual(h.mounted.map((item) => item.title), ["version-1", "version-2"]);
  for (const request of h.fetched) { assert.equal(request.options.cache, "no-store"); assert.equal(request.options.credentials, "same-origin"); }
  assert.equal(h.context.window.__runmeshLoading, false);
});

test("history navigation also revalidates instead of displaying an indefinite stale page", async () => {
  const h = harness(); await h.open("/admin/runners", true); await h.open("/admin", false);
  assert.equal(h.fetched.length, 2); assert.equal(h.mounted[1].push, false);
});

test("coalesces concurrent navigation to the latest explicit destination", async () => {
  const h = harness(); let resolveFirst;
  h.context.fetch = (url, options) => {
    h.fetched.push({ url, options });
    if (h.fetched.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    return Promise.resolve({ ok: true, text: async () => "latest" });
  };
  const first = h.open("/admin/runners"); h.open("/admin/clients"); h.open("/admin/settings");
  assert.equal(h.fetched.length, 1);
  resolveFirst({ ok: true, text: async () => "first" }); await first; await new Promise(setImmediate);
  assert.deepEqual(h.fetched.map((item) => new URL(item.url).pathname), ["/admin/runners", "/admin/settings"]);
  assert.equal(h.context.window.__runmeshLoading, false);
});

test("failed authentication/navigation does not silently restore cached data or multiply fallback fetches", async () => {
  const h = harness(); h.context.fetch = async () => { throw new Error("offline"); };
  await h.open("/admin/runners"); assert.equal(h.mounted.length, 0); assert.equal(h.context.location.href, "https://worker.test/admin/runners");
  assert.equal(h.context.window.__runmeshLoading, false);
  assert.doesNotMatch(load, /setInterval|setTimeout|XMLHttpRequest|loadAdminPageFrame|cachedPage/);
});

test("mounting a refreshed page removes obsolete forms and sensitive log DOM", () => {
  const calls = [], viewport = { children: [], style: {}, appendChild(item) { this.children.push(item); }, querySelectorAll() { return this.children; } };
  const make = () => ({ offsetHeight: 240, setAttribute() {}, remove() { viewport.children.splice(viewport.children.indexOf(this), 1); } });
  const stale = make(); viewport.children.push(stale); const fresh = make();
  const context = {
    document: { title: "old" }, pageContainer: () => fresh, ensurePageViewport: () => viewport,
    bindDynamicContent() {}, bindFeatureAlert() {}, setupDynamicNavigation() {},
    history: { pushState: (...args) => calls.push(args) }, setActivePage() {}, updateActiveNavigation() {}, applyLocale() {}, requestedLocale: () => "en",
  };
  vm.createContext(context); vm.runInContext(mount, context);
  context.mountAdminPage({ removeAttribute() {} }, "Fresh", "/admin", viewport, false, new URL("https://worker.test/admin"));
  assert.equal(viewport.children.length, 1); assert.equal(viewport.children[0], fresh); assert.equal(viewport.style.minHeight, "240px");
  assert.equal(context.document.title, "Fresh"); assert.equal(calls.length, 0);
});
