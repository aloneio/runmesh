import { copyText, copyValue } from "./clipboard.js";
import { bindPermissionControls } from "./permission-controls.js";
import { fragmentTarget, offsetFragmentTarget } from "./fragment.js";
function createPageControls({
  document,
  window,
  navigator,
  location,
  locale,
  navigate
}) {
  const bindings = /* @__PURE__ */new WeakMap();
  const {
    rememberLocale
  } = locale;
  function claim(node, kind) {
    let kinds = bindings.get(node);
    if (!kinds) {
      kinds = /* @__PURE__ */new Set();
      bindings.set(node, kinds);
    }
    if (kinds.has(kind)) return false;
    kinds.add(kind);
    return true;
  }
  function syncExecutionMode(form) {
    var selected = form.querySelector("input[name=\"execution_mode\"]:checked");
    if (!selected) selected = form.querySelector("select[name=\"execution_mode\"]");
    var privileged = !!selected && selected.value === "privileged_host";
    var confirmation = form.querySelector("[data-privileged-confirmation]");
    var warning = form.querySelector(".privileged-host-warning");
    var modeFieldset = form.querySelector("[data-execution-mode-form]");
    var reuse = !!modeFieldset && modeFieldset.getAttribute("data-reuse-privileged-confirmation") === "true";
    if (confirmation) confirmation.required = privileged && !reuse;
    if (warning) warning.hidden = !privileged || reuse;
  }
  function stabilizeTabPanels(root = document) {
    root.querySelectorAll(".enrollment-command-panels").forEach(function (container) {
      var panels = Array.prototype.slice.call(container.querySelectorAll("[data-panel]"));
      if (!panels.length) return;
      panels.forEach(function (panel) {
        panel.style.minHeight = "";
      });
      var max = 0;
      panels.forEach(function (panel) {
        var wasHidden = panel.hidden;
        panel.hidden = false;
        max = Math.max(max, panel.offsetHeight);
        panel.hidden = wasHidden;
      });
      if (max > 0) panels.forEach(function (panel) {
        panel.style.minHeight = max + "px";
      });
    });
  }
  function bindFeatureAlert(root) {
    var dialog = root.querySelector(".feature-alert-dialog");
    if (!dialog || !claim(dialog, "feature-alert")) return;
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) dialog.close();
    });
  }
  function bindPageControls(root) {
    if (!root) return;
    bindPermissionControls(root, claim);
    root.querySelectorAll('a[href^="#"]').forEach(function (link) {
      if (!claim(link, "fragment-offset")) return;
      function syncTargetOffset() {
        var target = fragmentTarget(root, link.getAttribute("href"));
        if (target) offsetFragmentTarget(document, target);
      }
      syncTargetOffset();
      // Keep native fragment focus, history and Back/Forward behavior. Re-read
      // the header before each click because its mobile navigation can wrap.
      link.addEventListener("click", syncTargetOffset);
    });
    root.querySelectorAll("[data-lang-toggle]").forEach(function (link) {
      if (!claim(link, "locale")) return;
      link.addEventListener("click", function (event) {
        var locale2 = link.getAttribute("data-lang-toggle") || "en";
        rememberLocale(locale2);
        var url = new URL(location.href);
        url.searchParams.set("lang", locale2);
        event.preventDefault();
        navigate(url.toString());
      });
    });
    root.querySelectorAll("[data-copy],[data-copy-source]").forEach(function (button) {
      if (!claim(button, "copy")) return;
      button.setAttribute("aria-live", "polite");
      button.setAttribute("aria-atomic", "true");
      button.addEventListener("click", function () {
        var result = copyText(copyValue(button), {
          document,
          navigator
        });
        var mark = function () {
          button.textContent = document.documentElement.lang === "zh-CN" ? "已复制" : "Copied";
          button.removeAttribute("title");
          button.classList.add("copied");
        };
        result.then(mark, function () {
          var isZh = document.documentElement.lang === "zh-CN";
          button.textContent = isZh ? "重试复制" : "Retry copy";
          button.setAttribute("title", isZh ? "复制失败，请手动复制或重试" : "Copy failed. Copy manually or retry.");
          button.classList.remove("copied");
        });
      });
    });
    root.querySelectorAll("[data-tab]").forEach(function (tab) {
      if (!claim(tab, "tab")) return;
      tab.addEventListener("click", function () {
        var target = tab.getAttribute("data-tab");
        var top = tab.getBoundingClientRect().top;
        root.querySelectorAll("[data-tab]").forEach(function (item) {
          item.setAttribute("aria-selected", String(item === tab));
          item.tabIndex = item === tab ? 0 : -1;
        });
        root.querySelectorAll("[data-panel]").forEach(function (panel) {
          panel.hidden = panel.getAttribute("data-panel") !== target;
        });
        var delta = tab.getBoundingClientRect().top - top;
        if (delta) window.scrollBy(0, delta);
      });
      tab.addEventListener("keydown", function (event) {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          var tabs = Array.prototype.slice.call(root.querySelectorAll("[data-tab]"));
          var next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
          next.focus();
          next.click();
        }
      });
    });
    root.querySelectorAll(".pwd-toggle-btn").forEach(function (btn) {
      if (!claim(btn, "password")) return;
      btn.addEventListener("click", function () {
        var wrap = btn.closest(".password-input-wrap");
        if (!wrap) return;
        var input = wrap.querySelector("input");
        if (!input) return;
        var isPwd = input.type === "password";
        var buttonLabel = btn.getAttribute(isPwd ? "data-password-hide" : "data-password-show");
        if (!buttonLabel) return;
        input.type = isPwd ? "text" : "password";
        btn.setAttribute("aria-label", buttonLabel);
        btn.setAttribute("title", buttonLabel);
        btn.innerHTML = isPwd ? "<svg class=\"eye-icon\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24\"></path><line x1=\"1\" y1=\"1\" x2=\"23\" y2=\"23\"></line></svg>" : "<svg class=\"eye-icon\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z\"></path><circle cx=\"12\" cy=\"12\" r=\"3\"></circle></svg>";
      });
    });
    root.querySelectorAll("form.login-form").forEach(function (form) {
      if (!claim(form, "login")) return;
      form.addEventListener("submit", function (event) {
        if (event.defaultPrevented) return;
        var btn = form.querySelector(".login-submit-btn");
        if (!btn || btn.disabled) return;
        var loadingText = btn.getAttribute("data-submit-pending");
        if (!loadingText) return;
        var origWidth = btn.offsetWidth;
        btn.style.width = origWidth > 0 ? origWidth + "px" : "100%";
        btn.disabled = true;
        btn.textContent = loadingText;
        // The native submit already owns validation, the submitter and navigation.
      });
    });
    root.querySelectorAll("form").forEach(function (form) {
      var controls = form.querySelectorAll("input[name=\"execution_mode\"],select[name=\"execution_mode\"]");
      if (!controls.length || !claim(form, "execution-mode")) return;
      controls.forEach(function (input) {
        input.addEventListener("change", function () {
          syncExecutionMode(form);
        });
      });
      syncExecutionMode(form);
    });
    root.querySelectorAll('select[name="access_mode"]').forEach(function (select) {
      var permissions = select.form && select.form.querySelector("[data-client-computer-permissions]");
      if (!permissions || !claim(select, "client-access")) return;
      function syncPermissions() {
        permissions.open = select.value === "native";
      }
      select.addEventListener("change", syncPermissions);
      syncPermissions();
    });
    root.querySelectorAll("form[data-client-delete]").forEach(function (form) {
      if (!claim(form, "client-delete")) return;
      form.addEventListener("submit", function (event) {
        var prompt = document.documentElement.lang === "zh-CN" ? "删除这个 AI 连接？其连接地址将立即失效。" : "Delete this AI connection? Its connection URL will stop working.";
        if (!window.confirm(prompt)) event.preventDefault();
      });
    });
    bindFeatureAlert(root);
    stabilizeTabPanels(root);
  }
  return {
    bindPageControls,
    stabilizeTabPanels
  };
}
export { createPageControls };
