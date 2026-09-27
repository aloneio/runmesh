import { createCentralTranslator } from "./messages.js";
import { createCentralApi } from "./api.js";
import { createCentralView } from "./view.js";
import { createServiceWorkflow } from "./services.js";
import { createSkillWorkflow } from "./skills.js";

/** One owner for refresh admission, snapshots and busy state across both workflows. */
export function bindCentralProduct(root) {
  var app = root.querySelector('[data-central-product]');
  if (!app || app.__productBound) return;
  app.__productBound = true;
  var t = createCentralTranslator(document.documentElement.lang),
    profiles = [],
    skills = [],
    busy = false,
    mustRefresh = false;
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
      if (isCurrent()) location.assign(url);
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
    return app.isConnected;
  }
  async function run(action) {
    if (busy || !isCurrent()) return;
    busy = true;
    var controls = Array.from(app.querySelectorAll('button,input,select'));
    var disabled = controls.map(function (c) {
      return c.disabled;
    });
    controls.forEach(function (c) {
      c.disabled = true;
    });
    say(t('working'));
    try {
      await action();
    } catch (error) {
      if (isCurrent()) say(error instanceof Error && error.name !== 'AbortError' ? error.message : t('connectionInterruptedRefreshToCheckWhetherTheOperationCompleted'), true);
    } finally {
      busy = false;
      controls.forEach(function (c, i) {
        if (c.isConnected) c.disabled = disabled[i];
      });
    }
  }
  async function refresh() {
    mustRefresh = true;
    view.invalidate();
    profiles = await client.list('profiles', 'profiles');
    skills = app.getAttribute('data-skills') === 'true' ? await client.list('skills', 'skills') : [];
    services.render(profiles);
    skillWorkflow.render(skills);
    mustRefresh = false;
    say(t('libraryIsUpToDate'));
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
    if (connected) {
      var connection = profiles.find(function (p) {
        return p.profile_id === connected;
      });
      history.replaceState(null, '', '/admin/central');
      if (connection) {
        await services.review(connection, true);
        return;
      }
    }
  });
}
