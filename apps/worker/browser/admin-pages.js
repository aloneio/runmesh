import { fragmentTarget, offsetFragmentTarget } from "./fragment.js";

function createAdminPages({
  document,
  location,
  history,
  bindPage,
  locale
}) {
  function updateActiveNavigation(path) {
    var normalized = path.replace(/\/$/, "") || "/admin";
    document.querySelectorAll(".control-nav a").forEach(function (link) {
      var href = link.getAttribute("href") || "";
      var active = href === "/admin" ? normalized === "/admin" : normalized === href || normalized.indexOf(href + "/") === 0;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");else link.removeAttribute("aria-current");
    });
  }
  function pageKey(url) {
    return url.pathname + (url.search || "");
  }
  function pageRoot(node) {
    return node && node.classList && node.classList.contains("shell") ? node : node && node.closest && node.closest(".shell") || node;
  }
  function pageContainer(root, key) {
    var container = document.createElement("div");
    container.className = "admin-page-container";
    container.setAttribute("data-page-container", "");
    container.setAttribute("data-page-key", key);
    container.setAttribute("aria-hidden", "true");
    container.appendChild(root);
    return container;
  }
  function ensurePageViewport() {
    var viewport = document.querySelector("[data-admin-viewport]");
    var active = document.querySelector("#main-content");
    if (!active) return viewport;
    var root = pageRoot(active);
    if (!root) return viewport;
    if (!viewport) {
      viewport = document.createElement("div");
      viewport.className = "admin-viewport";
      viewport.setAttribute("data-admin-viewport", "");
      root.parentNode.insertBefore(viewport, root);
      var initial = pageContainer(root, pageKey(new URL(location.href)));
      initial.setAttribute("data-page-title", document.title || "");
      initial.classList.add("is-active");
      initial.setAttribute("aria-hidden", "false");
      viewport.appendChild(initial);
    } else if (!root.closest("[data-page-container]")) {
      var initial = pageContainer(root, pageKey(new URL(location.href)));
      initial.setAttribute("data-page-title", document.title || "");
      initial.classList.add("is-active");
      initial.setAttribute("aria-hidden", "false");
      viewport.appendChild(initial);
    }
    return viewport;
  }
  function setActivePage(container, focus) {
    var viewport = ensurePageViewport();
    if (!viewport || !container) return;
    var containers = Array.prototype.slice.call(viewport.querySelectorAll("[data-page-container]"));
    containers.forEach(function (item) {
      var active = item === container;
      item.classList.toggle("is-active", active);
      item.classList.remove("is-leaving");
      item.setAttribute("aria-hidden", active ? "false" : "true");
      item.inert = !active;
      var main2 = item.id === "main-content" ? item : item.querySelector("#main-content");
      if (active) {
        if (!main2) main2 = item.tagName === "MAIN" ? item : item.querySelector("main");
        if (main2) main2.id = "main-content";
      } else if (main2) main2.removeAttribute("id");
    });
    if (focus) {
      var main = container.id === "main-content" ? container : container.querySelector("#main-content") || container.querySelector("main");
      if (main && typeof main.focus === "function") main.focus({
        preventScroll: true
      });
    }
  }
  function mountAdminPage(nextRoot, title, key, shouldPush, url) {
    nextRoot.removeAttribute("id");
    var container = pageContainer(nextRoot, key);
    container.setAttribute("data-page-title", title || "");
    var viewport = ensurePageViewport();
    viewport.appendChild(container);
    document.title = title || document.title;
    bindPage(container);
    if (shouldPush) history.pushState({
      runmeshAdmin: true
    }, "", url.pathname + url.search + url.hash);
    setActivePage(container, true);
    updateActiveNavigation(url.pathname);
    locale.applyLocale(locale.requestedLocale());
    Array.prototype.slice.call(viewport.querySelectorAll("[data-page-container]")).forEach(function (item) {
      if (item !== container) item.remove();
    });
    function scrollToTarget(target) {
      offsetFragmentTarget(document, target);
      target.scrollIntoView({ block: "start" });
    }
    var target = fragmentTarget(container, url.hash);
    if (target) {
      if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      scrollToTarget(target);
    } else if (shouldPush) {
      var main = container.querySelector("#main-content");
      if (main) scrollToTarget(main);
    }
  }
  return {
    pageRoot,
    mount: mountAdminPage,
    replaceCurrentUrl(url, key) {
      const active = document.querySelector("[data-page-container].is-active");
      if (!active) throw new Error("active page missing");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
      active.setAttribute("data-page-key", key);
    },
    initialize() {
      ensurePageViewport();
      const active = document.querySelector("[data-page-container].is-active");
      if (active) setActivePage(active, false);
    },
    setLoading(value) {
      document.documentElement.setAttribute("data-runmesh-navigation-busy", String(value));
      const main = document.querySelector("#main-content");
      if (main) {
        if (value) main.setAttribute("aria-busy", "true");else main.removeAttribute("aria-busy");
      }
    },
    ready() {
      document.documentElement.setAttribute("data-runmesh-navigation", "ready");
    }
  };
}
export { createAdminPages };
