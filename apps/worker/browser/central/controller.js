import { createCentralTranslator } from "./messages.js";
import { createCentralApi } from "./api.js";
import { createCentralView } from "./view.js";
import { createServiceWorkflow } from "./services.js";
import { createSkillWorkflow } from "./skills.js";

/** One owner for refresh admission, snapshots and busy state across both workflows. */
export function bindCentralProduct(root, { isCurrent: pageIsCurrent, navigate, replaceCurrentUrl }) {
  var app = root.querySelector('[data-central-product]');
  if (!app || app.__productBound) return;
  app.__productBound = true;
  var t = createCentralTranslator(document.documentElement.lang),
    profiles = [],
    skills = [],
    busy = false,
    mustRefresh = false;
  const lockedControls = new Map();
  var view = createCentralView(app, t, run),
    say = view.say;
  var client = createCentralApi({
    csrf: app.getAttribute('data-csrf'),
    t,
    isCurrent,
    refreshRequired: () => mustRefresh,
    requireRefresh: () => {
      mustRefresh = true;
    }
  });
  var services = createServiceWorkflow({
    app,
    api: client.request,
    view,
    t,
    refresh,
    run,
    navigate: url => {
      if (isCurrent()) navigate(url);
    }
  });
  var skillWorkflow = createSkillWorkflow({
    app,
    api: client.request,
    view,
    t,
    refresh,
    run,
    getSkills: () => skills
  });
  function isCurrent() {
    return app.isConnected && pageIsCurrent();
  }
  function lockControls() {
    app.querySelectorAll('button,input,select').forEach(function (control) {
      if (!lockedControls.has(control)) lockedControls.set(control, control.disabled);
      control.disabled = true;
    });
  }
  async function run(action) {
    if (busy || !isCurrent()) return;
    busy = true;
    app.setAttribute('aria-busy', 'true');
    lockControls();
    say(t('working'));
    try {
      await action();
    } catch (error) {
      if (isCurrent()) say(error instanceof Error && error.name !== 'AbortError' ? error.message : t('connectionInterruptedRefreshToCheckWhetherTheOperationCompleted'), true);
    } finally {
      busy = false;
      app.setAttribute('aria-busy', 'false');
      lockedControls.forEach(function (disabled, control) {
        if (control.isConnected) control.disabled = disabled;
      });
      lockedControls.clear();
    }
  }
  async function refresh({ silent = false } = {}) {
    mustRefresh = true;
    view.invalidate();
    profiles = await client.list('profiles', 'profiles');
    skills = app.getAttribute('data-skills') === 'true' ? await client.list('skills', 'skills') : [];
    services.render(profiles);
    skillWorkflow.render(skills);
    if (busy) lockControls();
    mustRefresh = false;
    if (!silent) say(t('libraryIsUpToDate'));
    return profiles;
  }
  app.querySelector('[data-product-refresh]').addEventListener('click', function () {
    run(refresh);
  });
  app.querySelectorAll('[data-central-tab]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      view.showTab(tab.getAttribute('data-central-tab'));
    });
  });
  run(async function () {
    await refresh();
    if (!isCurrent()) return;
    var connected = new URL(location.href).searchParams.get('connected');
    if (connected) replaceCurrentUrl('/admin/central');
    await services.resumePending(profiles, connected);
  });
}
