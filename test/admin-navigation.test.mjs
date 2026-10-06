import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAdminNavigation } from "../apps/worker/browser/admin-navigation.js";
import { createAdminPages } from "../apps/worker/browser/admin-pages.js";
import { createPageControls } from "../apps/worker/browser/page-controls.js";
import { createLocale } from "../apps/worker/browser/locale.js";
import { bindCentralProduct } from "../apps/worker/browser/central/controller.js";

function harness(href = "https://worker.test/admin") {
  const fetched = [], mounted = [], busy = [];
  const location = { href };
  const context = { location, document: { querySelectorAll: () => [] }, locale: { requestedLocale: () => "en" },
    fetch: async (url, options) => { fetched.push({ url, options }); return { ok: true, text: async () => "version-" + fetched.length }; },
    parse: markup => ({ title: markup, querySelector: () => ({ markup }) }), onError() {},
    view: { pageRoot: node => node, setLoading: value => busy.push(value), initialize() {}, ready() {},
      mount: (root, title, key, push, url) => mounted.push({ root, title, key, push, url: url.href }) },
  };
  const nav = createAdminNavigation({ ...context, fetch: (...args) => context.fetch(...args), parse: (...args) => context.parse(...args), onError: error => context.onError(error) });
  return { context, fetched, mounted, busy, nav, open: (path, push = true) => nav.open(new URL(path, location.href), push) };
}
test("revisiting a URL always revalidates with no-store and same-origin credentials", async () => {
  const h = harness(); await h.open("/admin", false); await h.open("/admin", false);
  assert.deepEqual(h.mounted.map(item => item.title), ["version-1", "version-2"]);
  for (const { options } of h.fetched) {
    const { signal, ...request } = options;
    assert.deepEqual(request, { cache: "no-store", credentials: "same-origin" });
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, true);
  }
  assert.equal(h.nav.isLoading(), false);
});
test("history navigation also revalidates without pushing another history entry", async () => {
  const h = harness(); await h.open("/admin/runners"); await h.open("/admin", false);
  assert.equal(h.fetched.length, 2); assert.equal(h.mounted[1].push, false);
});

test("native fragment history preserves the initial page and its live controller", async () => {
  const h = harness(), original = h.nav.capturePage();
  await h.nav.restore(new URL("/admin#main-content", h.context.location.href));
  await h.nav.restore(new URL("/admin", h.context.location.href));
  assert.equal(original(), true);
  assert.equal(h.fetched.length, 0);
  assert.equal(h.mounted.length, 0);
});

test("current URL replacement refuses a different page or origin", async () => {
  const h = harness("https://worker.test/admin/central?connected=fixture"), current = h.nav.capturePage(), replacements = [];
  h.context.view.replaceCurrentUrl = (...args) => replacements.push(args);
  for (const destination of ["/admin/clients", "https://other.test/admin/central"]) {
    assert.equal(h.nav.replaceCurrentUrl(destination), false);
  }
  await h.nav.restore(new URL("https://worker.test/admin/central?connected=fixture#main-content"));
  assert.deepEqual(replacements, []);
  assert.equal(h.fetched.length, 0);
  assert.equal(current(), true);
});

test("current URL replacement cannot revive loading or departed pages", async () => {
  const h = harness("https://worker.test/admin/central?connected=fixture"), replacements = [];
  h.context.view.replaceCurrentUrl = (...args) => replacements.push(args);
  let release;
  h.context.fetch = () => new Promise(resolve => { release = resolve; });
  const pending = h.open("/admin/clients");
  assert.equal(h.nav.replaceCurrentUrl("/admin/central"), false);
  h.nav.retire();
  release({ ok: true, text: async () => "departed" });
  await pending;
  assert.equal(h.nav.isLoading(), false);
  assert.equal(h.nav.replaceCurrentUrl("/admin/central"), false);
  assert.deepEqual(replacements, []);
  assert.equal(h.nav.capturePage()(), false);
});

test("a failed history replacement keeps the last rendered page key", async () => {
  const h = harness("https://worker.test/admin/central?connected=fixture"), current = h.nav.capturePage();
  h.context.view.replaceCurrentUrl = () => { throw new Error("history rejected"); };
  assert.throws(() => h.nav.replaceCurrentUrl("/admin/central"), /history rejected/u);
  await h.nav.restore(new URL("https://worker.test/admin/central?connected=fixture#main-content"));
  assert.equal(h.fetched.length, 0);
  assert.equal(current(), true);
  await h.nav.restore(new URL("https://worker.test/admin/central"));
  assert.equal(h.fetched.length, 1);
  assert.equal(current(), false);
});

for (const entry of ["initial", "mounted"]) test("OAuth return cleanup preserves fragment history and drafts on the " + entry + " page", async t => {
  const callback = "/admin/central?connected=service-fixture", clean = "https://worker.test/admin/central";
  const h = harness(entry === "initial" ? "https://worker.test" + callback : undefined);
  const originalGlobals = new Map(["document", "location", "history", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of originalGlobals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  const status = element(), create = element(), refresh = element(), draft = { value: "" };
  const list = { replaceChildren() {}, append() {} }, replacements = [], replacementLoading = [];
  const app = { isConnected: true, setAttribute() {},
    getAttribute: name => name === "data-skills" ? "false" : "fixture-csrf",
    querySelector: selector => ({ "[data-product-status]": status, "[data-service-list]": list,
      "[data-product-refresh]": refresh, "[data-service-create]": create })[selector] ?? null,
    querySelectorAll: () => [],
  };
  const history = { state: { runmeshAdmin: true }, replaceState(state, _title, url) {
    this.state = state; replacements.push(url); h.context.location.href = new URL(url, h.context.location.href).href;
  } };
  Object.assign(globalThis, { document: { documentElement: { lang: "en" }, createElement: () => element() },
    location: h.context.location, history, fetch: async () => Response.json({ state: "listed", profiles: [], next_after: null }) });
  h.context.view.replaceCurrentUrl = url => history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  let pageIsCurrent, mountedWhileLoading;
  function bind() {
    pageIsCurrent = h.nav.capturePage();
    bindCentralProduct({ querySelector: () => app }, { isCurrent: pageIsCurrent, navigate: url => h.nav.navigate(url),
      replaceCurrentUrl: url => { replacementLoading.push(h.nav.isLoading()); return h.nav.replaceCurrentUrl(url); } });
  }
  const mount = h.context.view.mount;
  h.context.view.mount = (...args) => {
    mount(...args); h.context.location.href = args[4].href; draft.value = "";
    if (args[2].startsWith("/admin/central")) { mountedWhileLoading = h.nav.isLoading(); bind(); }
  };
  if (entry === "initial") bind(); else await h.open(callback);
  await new Promise(setImmediate);
  assert.equal(h.context.location.href, clean);
  const reads = h.fetched.length, mounts = h.mounted.length, current = pageIsCurrent;
  draft.value = "Unsubmitted service address";
  for (const path of [clean + "#main-content", clean, clean + "#main-content"]) {
    h.context.location.href = path;
    await h.nav.restore(new URL(path));
    assert.equal(h.fetched.length, reads, "Same-page skip/Back/Forward must not reload the cleaned OAuth URL");
    assert.equal(h.mounted.length, mounts);
    assert.equal(draft.value, "Unsubmitted service address");
    assert.equal(current(), true);
  }
  assert.deepEqual(replacements, ["/admin/central"]);
  assert.deepEqual(replacementLoading, [false]);
  assert.deepEqual(history.state, { runmeshAdmin: true });
  if (entry === "mounted") assert.equal(mountedWhileLoading, true);
  await h.open("/admin/clients");
  assert.equal(h.fetched.length, reads + 1, "Cross-page navigation still revalidates");
  assert.equal(h.mounted.at(-1).key, "/admin/clients");
  assert.equal(current(), false);
});

test("fragment history uses the last mounted page while query changes revalidate", async () => {
  const h = harness();
  await h.open("/admin/clients?limit=25");
  const mountedPage = h.nav.capturePage();
  await h.nav.restore(new URL("/admin/clients?limit=25#add-client", h.context.location.href));
  assert.equal(mountedPage(), true);
  assert.equal(h.fetched.length, 1);
  await h.nav.restore(new URL("/admin/clients?limit=10#add-client", h.context.location.href));
  assert.equal(mountedPage(), false);
  assert.equal(h.fetched.length, 2);
  assert.equal(h.mounted[1].push, false);
});

test("fragment history during pending navigation revalidates the retired page", async () => {
  const h = harness(), original = h.nav.capturePage();
  let release;
  h.context.fetch = (url, options) => {
    h.fetched.push({ url, options });
    return h.fetched.length === 1 ? new Promise(resolve => { release = resolve; })
      : Promise.resolve({ ok: true, text: async () => "restored" });
  };
  const pending = h.open("/admin/runners");
  await h.nav.restore(new URL("/admin#main-content", h.context.location.href));
  assert.equal(original(), false);
  release({ ok: true, text: async () => "superseded" });
  await pending; await new Promise(setImmediate);
  assert.deepEqual(h.fetched.map(item => new URL(item.url).pathname), ["/admin/runners", "/admin"]);
  assert.deepEqual(h.mounted.map(item => [item.key, item.push]), [["/admin", false]]);
  assert.equal(original(), false);
});

for (const departure of ["native", "failed-mount"]) test("fragment history cannot revive a page after " + departure + " departure", async () => {
  const h = harness(), original = h.nav.capturePage();
  if (departure === "native") h.nav.retire();
  else {
    h.context.view.mount = () => { throw new Error("mount interrupted"); };
    await h.open("/admin");
  }
  await h.nav.restore(new URL("/admin#main-content", h.context.location.href));
  assert.equal(h.context.location.href, "https://worker.test/admin#main-content");
  assert.equal(original(), false);
  assert.equal(h.nav.capturePage()(), false);
  assert.equal(h.fetched.length, departure === "native" ? 0 : 1);
});

for (const push of [true, false]) test("a page retires when navigation starts, including history (push " + push + ")", async () => {
  const h = harness(), original = h.nav.capturePage();
  let release, mountedPage;
  h.context.fetch = () => new Promise(resolve => { release = resolve; });
  h.context.view.mount = () => { mountedPage = h.nav.capturePage(); };
  const pending = h.open("/admin/clients", push);
  assert.equal(original(), false);
  assert.equal(h.nav.isLoading(), true);
  release({ ok: true, text: async () => "clients" });
  await pending;
  assert.equal(original(), false);
  assert.equal(mountedPage(), true);
});

test("queued destinations retire all previous page owners before the next response", async () => {
  const h = harness(), original = h.nav.capturePage();
  let release, finalPage;
  let calls = 0;
  h.context.fetch = () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ok: true, text: async () => "last" });
  h.context.view.mount = () => { finalPage = h.nav.capturePage(); };
  const pending = h.open("/admin/runners");
  const first = h.nav.capturePage();
  void h.open("/admin/clients");
  const second = h.nav.capturePage();
  void h.open("/admin/settings");
  assert.deepEqual([original(), first(), second()], [false, false, false]);
  release({ ok: true, text: async () => "superseded" });
  await pending; await new Promise(setImmediate);
  assert.equal(finalPage(), true);
  assert.deepEqual([original(), first(), second()], [false, false, false]);
});

for (const failure of ["network", "locale"]) test("a " + failure + " fallback keeps the departed page retired after loading ends", async () => {
  const h = harness(), original = h.nav.capturePage();
  if (failure === "network") h.context.fetch = async () => { throw new Error("offline"); };
  else h.context.parse = () => ({ documentElement: { lang: "zh-CN" } });
  await h.open("/admin/clients");
  assert.equal(h.nav.isLoading(), false);
  assert.equal(original(), false);
  assert.equal(h.context.location.href, "https://worker.test/admin/clients");
});

test("a failed mount retires the partially bound page before full navigation", async () => {
  const h = harness(); let partiallyBound;
  h.context.view.mount = () => { partiallyBound = h.nav.capturePage(); throw new Error("history update failed"); };
  await h.open("/admin/clients");
  assert.equal(h.context.location.href, "https://worker.test/admin/clients");
  assert.equal(h.nav.isLoading(), false);
  assert.equal(partiallyBound(), false);
});

test("explicit full navigation retires the page and cannot create another current scope", () => {
  const h = harness(), current = h.nav.capturePage();
  h.nav.navigate("https://provider.example/authorize");
  assert.equal(current(), false);
  assert.equal(h.nav.capturePage()(), false);
  assert.equal(h.context.location.href, "https://provider.example/authorize");
  assert.equal(h.fetched.length, 0);
});

for (const phase of ["headers", "body"]) test("full navigation discards an in-flight soft " + phase + " response and its queued destination", async () => {
  const h = harness(), errors = []; let finish;
  h.context.onError = error => errors.push(error);
  h.context.fetch = (url, options) => {
    h.fetched.push({ url, options });
    const stalled = new Promise(resolve => { finish = resolve; });
    return phase === "headers" ? stalled : Promise.resolve({ ok: true, text: () => stalled });
  };
  const first = h.open("/admin/runners");
  await new Promise(setImmediate);
  void h.open("/admin/settings");
  h.nav.navigate("/admin?lang=zh-CN");
  assert.equal(h.fetched[0].options.signal.aborted, true);
  finish(phase === "headers" ? { ok: true, text: async () => "obsolete" } : "obsolete");
  await first;
  assert.equal(h.context.location.href, "https://worker.test/admin?lang=zh-CN");
  assert.equal(h.fetched.length, 1);
  assert.equal(h.mounted.length, 0);
  assert.equal(h.nav.isLoading(), false);
  assert.equal(h.nav.capturePage()(), false);
  assert.deepEqual(errors, []);
});

test("a later explicit destination replaces a pending full navigation without mounting the old page", async () => {
  const h = harness();
  h.nav.navigate("/admin?lang=zh-CN");
  await h.open("/admin/clients");
  assert.equal(h.context.location.href, "https://worker.test/admin/clients");
  assert.equal(h.fetched.length, 0);
  assert.equal(h.mounted.length, 0);
  assert.equal(h.nav.capturePage()(), false);
});

test("native page departure retires its scope without replacing the browser submission", () => {
  const h = harness(), current = h.nav.capturePage();
  h.nav.retire();
  assert.equal(current(), false);
  assert.equal(h.nav.capturePage()(), false);
  assert.equal(h.context.location.href, "https://worker.test/admin");
  assert.equal(h.fetched.length, 0);
});
test("concurrent navigation coalesces to the latest destination within one owner", async () => {
  const h = harness(); let resolveFirst;
  h.context.fetch = (url, options) => { h.fetched.push({ url, options }); return h.fetched.length === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ ok: true, text: async () => "latest" }); };
  const first = h.open("/admin/runners"); void h.open("/admin/clients"); void h.open("/admin/settings");
  assert.equal(h.fetched.length, 1); assert.equal(h.nav.isLoading(), true);
  resolveFirst({ ok: true, text: async () => "first" }); await first; await new Promise(setImmediate);
  assert.deepEqual(h.fetched.map(item => new URL(item.url).pathname), ["/admin/runners", "/admin/settings"]);
  assert.deepEqual(h.mounted.map(item => item.key), ["/admin/settings"]);
  assert.equal(h.nav.isLoading(), false);
});
for (const [destination, push] of [["/admin", false], ["/admin/settings", true]])
test("superseded responses preserve the final page and history destination " + destination, async () => {
  const h = harness(), history = [];
  let finishBody;
  h.context.fetch = (url, options) => {
    h.fetched.push({ url, options });
    return Promise.resolve({ ok: true, text: () => h.fetched.length === 1
      ? new Promise(resolve => { finishBody = resolve; }) : Promise.resolve("latest") });
  };
  h.context.view.mount = (_root, _title, key, shouldPush, url) => {
    h.mounted.push({ key });
    if (shouldPush) { history.push(url.href); h.context.location.href = url.href; }
  };
  const pending = h.open("/admin/runners");
  await new Promise(setImmediate);
  void h.open(destination, push);
  finishBody("superseded");
  await pending; await new Promise(setImmediate);
  assert.deepEqual(h.mounted, [{ key: destination }]);
  assert.equal(new URL(h.context.location.href).pathname, destination);
  assert.deepEqual(history, push ? ["https://worker.test" + destination] : []);
  assert.equal(h.nav.isLoading(), false);
});
test("failed navigation falls back to a full request and never mounts stale content", async () => {
  const h = harness(); h.context.fetch = async () => { throw new Error("offline"); };
  await h.open("/admin/runners"); assert.equal(h.mounted.length, 0);
  assert.equal(h.context.location.href, "https://worker.test/admin/runners"); assert.equal(h.nav.isLoading(), false);
});
test("a changed server locale triggers full navigation without mounting a mixed-language page", async () => {
  const h = harness(); h.context.parse = () => ({ documentElement: { lang: "zh-CN" }, querySelector: () => ({}) });
  await h.open("/admin?lang=zh-CN"); assert.equal(h.mounted.length, 0);
  assert.equal(h.context.location.href, "https://worker.test/admin?lang=zh-CN");
});
for (const phase of ["headers", "body"]) test("stalled navigation " + phase + " releases its owner and falls back after the deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); let finish, settled = false;
  h.context.fetch = (url, options) => {
    h.fetched.push({ url, options });
    const stalled = new Promise((resolve, reject) => {
      finish = resolve;
      options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
    return phase === "headers" ? stalled : Promise.resolve({ ok: true, text: () => stalled });
  };
  const pending = h.open("/admin/runners").then(() => { settled = true; });
  await new Promise(setImmediate);
  t.mock.timers.tick(25000);
  await new Promise(setImmediate);
  const observed = { settled, busy: h.nav.isLoading(), url: h.context.location.href, mounted: h.mounted.length, aborted: h.fetched[0].options.signal?.aborted };
  // Release the old implementation before asserting so a failed regression is clean.
  finish(phase === "headers" ? { ok: true, text: async () => "late" } : "late");
  await pending;
  assert.deepEqual(observed, { settled: true, busy: false, url: "https://worker.test/admin/runners", mounted: 0, aborted: true });
});
for (const failure of ["network", "locale"]) test(failure + " navigation fallback uses the last queued destination once", async () => {
  const h = harness(); let finish, reject;
  h.context.fetch = (url, options) => {
    h.fetched.push({ url, options });
    return h.fetched.length === 1 ? new Promise((resolve, fail) => { finish = resolve; reject = fail; }) : Promise.resolve({ ok: true, text: async () => "latest" });
  };
  if (failure === "locale") h.context.parse = () => ({ documentElement: { lang: "zh-CN" }, querySelector: () => ({}) });
  const first = h.open("/admin/runners");
  void h.open("/admin/clients"); void h.open("/admin/settings");
  if (failure === "network") reject(new Error("offline"));
  else finish({ ok: true, text: async () => "first" });
  await first; await new Promise(setImmediate);
  assert.equal(h.context.location.href, "https://worker.test/admin/settings");
  assert.equal(h.fetched.length, 1);
  assert.equal(h.mounted.length, 0);
  assert.equal(h.nav.isLoading(), false);
});
function element() {
  const events = new Map(), attrs = new Map(), classes = new Set();
  return { events, style: {}, offsetHeight: 240, id: "", tagName: "DIV", querySelector: () => null, querySelectorAll: () => [],
    addEventListener(type, fn) { events.set(type, [...(events.get(type) ?? []), fn]); },
    dispatch(type, event = {}) { for (const fn of events.get(type) ?? []) fn(event); },
    setAttribute(name, value) { attrs.set(name, value); }, getAttribute: name => attrs.get(name) ?? null,
    removeAttribute(name) { attrs.delete(name); }, hasAttribute: name => attrs.has(name),
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } },
  };
}
test("current URL replacement updates the active container without remounting or losing history state", () => {
  const active = element(), stale = element(), replacements = [], state = { runmeshAdmin: true, marker: "kept" };
  active.setAttribute("data-page-key", "/admin/central?connected=fixture");
  stale.setAttribute("data-page-key", "/admin/clients");
  const document = { querySelector: selector => selector === "[data-page-container].is-active" ? active : null,
    createElement() { assert.fail("URL cleanup must not remount a page"); } };
  const history = { state, replaceState: (...args) => replacements.push(args) };
  const view = createAdminPages({ document, location: {}, history, bindPage() { assert.fail("URL cleanup must not rebind controllers"); }, locale: {} });
  view.replaceCurrentUrl(new URL("https://worker.test/admin/central#main-content"), "/admin/central");
  assert.deepEqual(replacements, [[state, "", "/admin/central#main-content"]]);
  assert.equal(replacements[0][0], state);
  assert.equal(active.getAttribute("data-page-key"), "/admin/central");
  assert.equal(stale.getAttribute("data-page-key"), "/admin/clients");
});

test("mounting a page removes obsolete forms and sensitive DOM through the view module", () => {
  const viewport = { children: [], style: {}, appendChild(node) { this.children.push(node); }, querySelectorAll() { return this.children; }, querySelector() { return this.children[0]; } };
  const make = () => { const node = element(); node.appendChild = root => { node.querySelector = () => root; }; node.remove = () => viewport.children.splice(viewport.children.indexOf(node), 1); return node; };
  const stale = make(); viewport.children.push(stale); const bound = [], history = [];
  const document = { title: "old", querySelector: selector => selector === "[data-admin-viewport]" ? viewport : null, querySelectorAll: () => [], createElement: make };
  const view = createAdminPages({ document, location: { href: "https://worker.test/admin" }, history: { pushState: (...args) => history.push(args) }, bindPage: root => bound.push(root), locale: { applyLocale() {}, requestedLocale: () => "en" } });
  view.mount(element(), "Fresh", "/admin", false, new URL("https://worker.test/admin"));
  assert.equal(viewport.children.length, 1); assert.notEqual(viewport.children[0], stale);
  assert.equal(viewport.children[0], bound[0]); assert.equal(document.title, "Fresh"); assert.equal(history.length, 0);
  assert.equal(viewport.style.minHeight, undefined);
});

for (const [fragment, push, expected] of [["#add-client", true, "fragment"], ["#add%2Dclient", false, "fragment"], ["", true, "main"], ["#missing", true, "main"], ["#%invalid", true, "main"], ["", false, "preserved"]])
test("mounted navigation places focus and scroll at " + (fragment || "the page") + " (push " + push + ")", () => {
  const scrolled = [], focused = [], viewport = {
    children: [], style: {}, appendChild(node) { this.children.push(node); }, querySelectorAll() { return this.children; },
  };
  const main = { id: "main-content", style: {}, focus: () => focused.push("main"), scrollIntoView: options => scrolled.push(["main", options]) };
  const target = element(); target.tabIndex = -1;
  target.focus = options => focused.push(["fragment", options]);
  target.scrollIntoView = options => scrolled.push(["fragment", options]);
  const make = () => {
    const node = element();
    node.appendChild = () => { node.querySelector = () => main; };
    node.remove = () => viewport.children.splice(viewport.children.indexOf(node), 1);
    return node;
  };
  const document = { title: "Previous", createElement: make, querySelectorAll: () => [],
    querySelector: selector => selector === "[data-admin-viewport]" ? viewport : selector === ".app-header" ? { offsetHeight: 124 } : null,
    getElementById: id => id === "add-client" ? target : null,
  };
  const url = new URL("https://worker.test/admin/clients" + fragment);
  const view = createAdminPages({ document, location: { href: "https://worker.test/admin/central" }, history: { pushState() {} }, bindPage() {}, locale: { applyLocale() {}, requestedLocale: () => "en" } });
  view.mount(element(), "Clients", "/admin/clients", push, url);
  assert.deepEqual(scrolled, expected === "preserved" ? [] : [[expected, { block: "start" }]]);
  assert.deepEqual(focused, expected === "fragment" ? ["main", ["fragment", { preventScroll: true }]] : ["main"]);
  assert.equal(target.getAttribute("tabindex"), expected === "fragment" ? "-1" : null);
  assert.equal((expected === "fragment" ? target : main).style.scrollMarginTop, expected === "preserved" ? undefined : "140px");
});
test("server-selected locale is independent of navigator preferences and unrelated cookies", () => {
  for (const lang of ["en", "zh-CN"]) assert.equal(createLocale({ document: { documentElement: { lang }, cookie: "fake_runmesh_lang=zh-CN" } }).requestedLocale(), lang);
});
function controlsFixture() {
  const copied = [], document = { documentElement: { lang: "en" } }, location = { href: "https://worker.test/admin" };
  const controls = createPageControls({ document, location, window: { scrollBy() {} }, navigator: { clipboard: { writeText: async text => { copied.push(text); } } }, locale: createLocale({ document }) });
  const root = entries => ({ querySelectorAll: selector => entries[selector] ?? [], querySelector: () => null });
  return { controls, copied, root };
}

test("same-page anchors use their own page and current header without replacing native navigation", () => {
  const header = { offsetHeight: 154 }, stale = element(), current = element();
  stale.id = current.id = "add-client";
  const document = { documentElement: { lang: "en" }, querySelector: selector => selector === ".app-header" ? header : null };
  const location = { href: "https://worker.test/admin/clients" };
  const controls = createPageControls({ document, location, window: {}, navigator: {}, locale: createLocale({ document }),
    navigate() { assert.fail("A native fragment must not invoke full navigation"); } });
  const link = element(); link.setAttribute("href", "#add%2Dclient");
  const root = { querySelector: () => null, querySelectorAll: selector => selector === 'a[href^="#"]' ? [link] : selector === "[id]" ? [current] : [] };
  document.querySelectorAll = selector => selector === "[id]" ? [stale] : [];
  controls.bindPageControls(root); controls.bindPageControls(root);
  assert.equal(current.style.scrollMarginTop, "170px");
  assert.equal(stale.style.scrollMarginTop, undefined, "A mounted page must not update its predecessor's target");
  assert.equal(link.events.get("click").length, 1);
  header.offsetHeight = 196;
  link.dispatch("click", { preventDefault() { assert.fail("Fragment clicks retain their native default action"); } });
  assert.equal(current.style.scrollMarginTop, "212px");
  assert.equal(location.href, "https://worker.test/admin/clients");
  for (const href of ["#%invalid", "#missing", "#"]) {
    link.setAttribute("href", href); link.dispatch("click");
    assert.equal(current.style.scrollMarginTop, "212px");
  }
});

test("language controls delegate the full destination to the navigation owner", () => {
  const document = { documentElement: { lang: "en" } }, destinations = [];
  const location = { href: "https://worker.test/admin/central?connected=example#tools" };
  const controls = createPageControls({ document, window: {}, navigator: {}, location,
    locale: createLocale({ document }), navigate: url => destinations.push(url) });
  const link = element(); link.setAttribute("data-lang-toggle", "zh-CN");
  const root = { querySelectorAll: selector => selector === "[data-lang-toggle]" ? [link] : [], querySelector: () => null };
  controls.bindPageControls(root); controls.bindPageControls(root);
  let prevented = false;
  link.dispatch("click", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(destinations, ["https://worker.test/admin/central?connected=example&lang=zh-CN#tools"]);
  assert.equal(location.href, "https://worker.test/admin/central?connected=example#tools");
  assert.match(document.cookie, /^runmesh_lang=zh-CN;/u);
});

function permissionFormFixture(withProfile = false) {
  const form = element(), requirements = { read: "", edit: "read", shell: "read edit job_control", job_control: "read" };
  const selects = Object.fromEntries(Object.entries(requirements).map(([name, required]) => {
    const select = element(); select.name = name; select.value = String(name === "read");
    select.setAttribute("data-permission-requires", required);
    return [name, select];
  }));
  const profile = withProfile ? element() : null;
  if (profile) {
    profile.value = "read_only";
    Object.defineProperty(profile, "selectedOptions", { get: () => [{ getAttribute: () => ({
      read_only: "read", edit_only: "read edit", controlled_exec: "read edit shell job_control",
    })[profile.value] ?? null }] });
  }
  form.querySelectorAll = selector => selector === "select[data-permission-requires]" ? Object.values(selects) : [];
  form.querySelector = selector => selector === 'select[name="profile"]' ? profile : null;
  return { form, selects, profile, values: () => Object.fromEntries(Object.entries(selects).map(([name, select]) => [name, select.value === "true"])),
    change(name, value) { selects[name].value = String(value); selects[name].dispatch("change"); } };
}

test("permission controls visibly enable Shell dependencies and remove dependent grants within their own form", () => {
  const h = controlsFixture(), runner = permissionFormFixture(), workspace = permissionFormFixture(true);
  const root = h.root({ form: [runner.form, workspace.form] });
  h.controls.bindPageControls(root); h.controls.bindPageControls(root);
  runner.change("shell", true);
  assert.deepEqual(runner.values(), { read: true, edit: true, shell: true, job_control: true });
  assert.deepEqual(workspace.values(), { read: true, edit: false, shell: false, job_control: false });
  runner.change("edit", false);
  assert.deepEqual(runner.values(), { read: true, edit: false, shell: false, job_control: true });
  runner.change("read", false);
  assert.deepEqual(runner.values(), { read: false, edit: false, shell: false, job_control: false });
  runner.change("job_control", true);
  assert.deepEqual(runner.values(), { read: true, edit: false, shell: false, job_control: true });
  assert.equal(runner.selects.shell.events.get("change").length, 1);
});

test("workspace presets update visible permissions and explicit changes switch the form to Custom", () => {
  const h = controlsFixture(), workspace = permissionFormFixture(true);
  h.controls.bindPageControls(h.root({ form: [workspace.form] }));
  workspace.profile.value = "controlled_exec"; workspace.profile.dispatch("change");
  assert.deepEqual(workspace.values(), { read: true, edit: true, shell: true, job_control: true });
  workspace.change("edit", false);
  assert.equal(workspace.profile.value, "custom");
  assert.deepEqual(workspace.values(), { read: true, edit: false, shell: false, job_control: true });
  workspace.profile.value = "read_only"; workspace.profile.dispatch("change");
  assert.deepEqual(workspace.values(), { read: true, edit: false, shell: false, job_control: false });
  workspace.change("shell", true);
  assert.equal(workspace.profile.value, "custom");
  assert.deepEqual(workspace.values(), { read: true, edit: true, shell: true, job_control: true });
});

test("command panel heights shrink after a wider resize and retain the selected operating system", () => {
  const h = controlsFixture();
  const panels = [false, true, true].map((hidden, index) => ({ hidden, style: {}, naturalHeight: 500 + 100 * index,
    get offsetHeight() { return Math.max(this.naturalHeight, Number.parseFloat(this.style.minHeight) || 0); },
  }));
  const root = h.root({ ".enrollment-command-panels": [{ querySelectorAll: () => panels }] });
  h.controls.stabilizeTabPanels(root);
  assert.deepEqual(panels.map(panel => panel.style.minHeight), ["700px", "700px", "700px"]);
  panels.forEach((panel, index) => { panel.naturalHeight = 200 + 50 * index; });
  h.controls.stabilizeTabPanels(root);
  assert.deepEqual(panels.map(panel => panel.style.minHeight), ["300px", "300px", "300px"]);
  assert.deepEqual(panels.map(panel => panel.hidden), [false, true, true]);
});
test("initial and dynamic controls share an idempotent clipboard handler", async () => {
  const h = controlsFixture(), initial = element(), dynamic = element(); initial.setAttribute("data-copy", "initial"); dynamic.setAttribute("data-copy", "dynamic");
  for (const button of [initial, dynamic]) { const root = h.root({ "[data-copy],[data-copy-source]": [button] }); h.controls.bindPageControls(root); h.controls.bindPageControls(root); button.dispatch("click"); }
  await new Promise(setImmediate); assert.deepEqual(h.copied, ["initial", "dynamic"]);
  assert.equal(initial.textContent, "Copied"); assert.equal(dynamic.textContent, "Copied");
});
for (const lang of ["en", "zh-CN"]) for (const failure of ["clipboard rejection", "legacy false", "legacy exception"])
test(`copy controls report ${failure} in ${lang} and recover on retry`, async () => {
  let failed = true, selected;
  const copied = [], attached = new Set();
  const document = { documentElement: { lang }, body: { appendChild: node => attached.add(node) },
    createElement() {
      const area = element(); area.select = () => { selected = area; }; area.remove = () => attached.delete(area); return area;
    },
    execCommand() {
      if (failed && failure === "legacy exception") throw new Error("private clipboard error");
      if (failed) return false;
      copied.push(selected.value); return true;
    },
  };
  const navigator = failure === "clipboard rejection" ? { clipboard: { async writeText(text) {
    if (failed) throw new Error("private clipboard error"); copied.push(text);
  } } } : {};
  const controls = createPageControls({ document, navigator, window: {}, location: {}, locale: createLocale({ document }) });
  const button = element(); button.textContent = "Copy MCP URL"; button.setAttribute("data-copy", "one-time-connection-url");
  const root = { querySelectorAll: selector => selector === "[data-copy],[data-copy-source]" ? [button] : [], querySelector: () => null };
  controls.bindPageControls(root); controls.bindPageControls(root);
  assert.equal(button.getAttribute("aria-live"), "polite");
  assert.equal(button.getAttribute("aria-atomic"), "true");
  const failMessage = lang === "zh-CN" ? "复制失败，请手动复制或重试" : "Copy failed. Copy manually or retry.";
  const retryLabel = lang === "zh-CN" ? "重试复制" : "Retry copy";
  for (const reject of [true, false, true]) {
    failed = reject; button.dispatch("click"); await new Promise(setImmediate);
    assert.equal(button.textContent, reject ? retryLabel : lang === "zh-CN" ? "已复制" : "Copied");
    assert.equal(button.getAttribute("title"), reject ? failMessage : null);
    assert.equal(button.classList.contains("copied"), !reject);
    assert.equal(attached.size, 0, "temporary clipboard content must be removed after success or failure");
    assert.equal(button.getAttribute("data-copy"), "one-time-connection-url");
  }
  assert.deepEqual(copied, ["one-time-connection-url"]);
  assert.equal(button.events.get("click").length, 1);
});

test("initial and dynamic password controls update the same icon and accessible labels once", () => {
  const h = controlsFixture(), icons = [];
  for (let i = 0; i < 2; i++) {
    const button = element(), input = { type: "password" }; button.closest = () => ({ querySelector: () => input });
    const root = h.root({ ".pwd-toggle-btn": [button] }); h.controls.bindPageControls(root); h.controls.bindPageControls(root);
    button.dispatch("click"); assert.equal(input.type, "text"); assert.equal(button.getAttribute("aria-label"), "Hide password"); icons.push(button.innerHTML);
    button.dispatch("click"); assert.equal(input.type, "password"); assert.equal(button.getAttribute("title"), "Show password");
  }
  assert.equal(icons[0], icons[1]); assert.match(icons[0], /<line/);
});
test("rebinding execution-mode controls does not duplicate listeners or lose initial synchronization", () => {
  const h = controlsFixture(), input = element(), confirmation = {}, warning = {}; input.value = "privileged_host";
  const form = { querySelectorAll: selector => selector === 'input[name="execution_mode"],select[name="execution_mode"]' ? [input] : [], querySelector: selector => selector === '[input-unused]' ? null : selector.includes(":checked") ? input : selector === "[data-privileged-confirmation]" ? confirmation : selector === ".privileged-host-warning" ? warning : null };
  const root = h.root({ form: [form] }); h.controls.bindPageControls(root); h.controls.bindPageControls(root);
  assert.equal(input.events.get("change").length, 1); assert.equal(confirmation.required, true); assert.equal(warning.hidden, false);
  input.value = "dedicated_user"; input.dispatch("change"); assert.equal(confirmation.required, false); assert.equal(warning.hidden, true);
});
test("client computer permissions follow access type on initial and dynamically mounted pages", () => {
  const h = controlsFixture();
  for (const initialMode of ["central", "native"]) {
    const select = element(), permissions = { open: false }; select.value = initialMode;
    select.form = { querySelector: selector => selector === "[data-client-computer-permissions]" ? permissions : null };
    const root = h.root({ 'select[name="access_mode"]': [select] });
    h.controls.bindPageControls(root); h.controls.bindPageControls(root);
    assert.equal(permissions.open, initialMode === "native");
    assert.equal(select.events.get("change").length, 1);
    select.value = "native"; select.dispatch("change"); assert.equal(permissions.open, true);
    permissions.open = false; h.controls.bindPageControls(root); assert.equal(permissions.open, false);
    select.value = "central"; select.dispatch("change"); assert.equal(permissions.open, false);
    select.value = "native"; select.dispatch("change"); assert.equal(permissions.open, true);
  }
});

test("client deletion asks once and cancelling keeps both initial and mounted forms intact", () => {
  for (const lang of ["en", "zh-CN"]) {
    const document = { documentElement: { lang } }, prompts = [];
    let approved = false;
    const controls = createPageControls({ document, window: { confirm(prompt) { prompts.push(prompt); return approved; } }, location: {}, navigator: {}, locale: createLocale({ document }) });
    for (const form of [element(), element()]) {
      const root = { querySelectorAll: selector => selector === "form[data-client-delete]" ? [form] : [], querySelector: () => null };
      controls.bindPageControls(root); controls.bindPageControls(root);
      assert.equal(form.events.get("submit").length, 1);
      let prevented = false;
      approved = false; form.dispatch("submit", { preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
      prevented = false;
      approved = true; form.dispatch("submit", { preventDefault() { prevented = true; } });
      assert.equal(prevented, false);
    }
    assert.equal(prompts.length, 4);
    assert.ok(prompts.every(prompt => prompt.includes(lang === "zh-CN" ? "删除这个 AI 连接" : "Delete this AI connection")));
  }
});

test("page containers stay synchronous and do not cross-fade sensitive content", () => {
  const css = readFileSync(new URL("../apps/worker/src/admin-styles.ts", import.meta.url), "utf8");
  const container = css.match(/\.admin-page-container\{([^}]+)\}/)?.[1] ?? "";
  assert.ok(container.includes("display:none")); assert.doesNotMatch(container, /animation|transition|opacity|will-change/);
});
