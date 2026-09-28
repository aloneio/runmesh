import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAdminNavigation } from "../apps/worker/browser/admin-navigation.js";
import { createAdminPages } from "../apps/worker/browser/admin-pages.js";
import { createPageControls } from "../apps/worker/browser/page-controls.js";
import { createLocale } from "../apps/worker/browser/locale.js";

function harness() {
  const fetched = [], mounted = [], busy = [];
  const location = { href: "https://worker.test/admin" };
  const context = { location, document: { querySelectorAll: () => [] }, locale: { requestedLocale: () => "en" },
    fetch: async (url, options) => { fetched.push({ url, options }); return { ok: true, text: async () => "version-" + fetched.length }; },
    parse: markup => ({ title: markup, querySelector: () => ({ markup }) }), onError() {},
    view: { pageRoot: node => node, setLoading: value => busy.push(value), initialize() {}, ready() {},
      mount: (root, title, key, push, url) => mounted.push({ root, title, key, push, url: url.href }) },
  };
  const nav = createAdminNavigation({ ...context, fetch: (...args) => context.fetch(...args), parse: (...args) => context.parse(...args) });
  return { context, fetched, mounted, busy, nav, open: (path, push = true) => nav.open(new URL(path, location.href), push) };
}
test("revisiting a URL always revalidates with no-store and same-origin credentials", async () => {
  const h = harness(); await h.open("/admin", false); await h.open("/admin", false);
  assert.deepEqual(h.mounted.map(item => item.title), ["version-1", "version-2"]);
  for (const { options } of h.fetched) assert.deepEqual(options, { cache: "no-store", credentials: "same-origin" });
  assert.equal(h.nav.isLoading(), false);
});
test("history navigation also revalidates without pushing another history entry", async () => {
  const h = harness(); await h.open("/admin/runners"); await h.open("/admin", false);
  assert.equal(h.fetched.length, 2); assert.equal(h.mounted[1].push, false);
});
test("concurrent navigation coalesces to the latest destination within one owner", async () => {
  const h = harness(); let resolveFirst;
  h.context.fetch = (url, options) => { h.fetched.push({ url, options }); return h.fetched.length === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ ok: true, text: async () => "latest" }); };
  const first = h.open("/admin/runners"); void h.open("/admin/clients"); void h.open("/admin/settings");
  assert.equal(h.fetched.length, 1); assert.equal(h.nav.isLoading(), true);
  resolveFirst({ ok: true, text: async () => "first" }); await first; await new Promise(setImmediate);
  assert.deepEqual(h.fetched.map(item => new URL(item.url).pathname), ["/admin/runners", "/admin/settings"]);
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
test("mounting a page removes obsolete forms and sensitive DOM through the view module", () => {
  const viewport = { children: [], style: {}, appendChild(node) { this.children.push(node); }, querySelectorAll() { return this.children; }, querySelector() { return this.children[0]; } };
  const make = () => { const node = element(); node.appendChild = root => { node.querySelector = () => root; }; node.remove = () => viewport.children.splice(viewport.children.indexOf(node), 1); return node; };
  const stale = make(); viewport.children.push(stale); const bound = [], history = [];
  const document = { title: "old", querySelector: selector => selector === "[data-admin-viewport]" ? viewport : null, querySelectorAll: () => [], createElement: make };
  const view = createAdminPages({ document, location: { href: "https://worker.test/admin" }, history: { pushState: (...args) => history.push(args) }, bindPage: root => bound.push(root), locale: { applyLocale() {}, requestedLocale: () => "en" } });
  view.mount(element(), "Fresh", "/admin", false, new URL("https://worker.test/admin"));
  assert.equal(viewport.children.length, 1); assert.notEqual(viewport.children[0], stale);
  assert.equal(viewport.children[0], bound[0]); assert.equal(document.title, "Fresh"); assert.equal(history.length, 0);
  assert.equal(viewport.style.minHeight, "240px");
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
test("initial and dynamic controls share an idempotent clipboard handler", async () => {
  const h = controlsFixture(), initial = element(), dynamic = element(); initial.setAttribute("data-copy", "initial"); dynamic.setAttribute("data-copy", "dynamic");
  for (const button of [initial, dynamic]) { const root = h.root({ "[data-copy],[data-copy-source]": [button] }); h.controls.bindPageControls(root); h.controls.bindPageControls(root); button.dispatch("click"); }
  await new Promise(setImmediate); assert.deepEqual(h.copied, ["initial", "dynamic"]);
  assert.equal(initial.textContent, "Copied"); assert.equal(dynamic.textContent, "Copied");
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
  const form = { querySelectorAll: () => [input], querySelector: selector => selector === '[input-unused]' ? null : selector.includes(":checked") ? input : selector === "[data-privileged-confirmation]" ? confirmation : selector === ".privileged-host-warning" ? warning : null };
  const root = h.root({ form: [form] }); h.controls.bindPageControls(root); h.controls.bindPageControls(root);
  assert.equal(input.events.get("change").length, 1); assert.equal(confirmation.required, true); assert.equal(warning.hidden, false);
  input.value = "dedicated_user"; input.dispatch("change"); assert.equal(confirmation.required, false); assert.equal(warning.hidden, true);
});
test("page containers stay synchronous and do not cross-fade sensitive content", () => {
  const css = readFileSync(new URL("../apps/worker/src/admin-styles.ts", import.meta.url), "utf8");
  const container = css.match(/\.admin-page-container\{([^}]+)\}/)?.[1] ?? "";
  assert.ok(container.includes("display:none")); assert.doesNotMatch(container, /animation|transition|opacity|will-change/);
});
