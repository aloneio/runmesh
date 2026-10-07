import { createCentralTranslator } from "./messages.js";
import { createCentralApi } from "./api.js";
import { createCentralView } from "./view.js";
import { createServiceWorkflow } from "./services.js";
import { createSkillWorkflow } from "./skills.js";
import { bindRegistryImport } from "./registry.js";
import { createCentralOperations } from './operations.js';

const bound = new WeakSet();

/** Own collection snapshots and admission without coupling Skill work to remote MCP recovery. */
export function bindCentralProduct(root, { isCurrent: pageIsCurrent, navigate, replaceCurrentUrl }) {
  const app = root.querySelector('[data-central-product]');
  if (!app || bound.has(app)) return;
  bound.add(app);
  const t = createCentralTranslator(document.documentElement.lang), uncertain = new Map();
  let profiles = [], skills = [], profileReads = Promise.resolve(), skillReads = Promise.resolve();
  let profilesReady = false, skillsReady = false;
  const runService = (action, scope = 'mcp-create', options) => operations.run(action, scope, options);
  const runSkill = action => operations.run(action, 'skills');
  const view = createCentralView(app, t, runService), skillView = createCentralView(app, t, runSkill);
  const operations = createCentralOperations({ app, isCurrent,
    working: () => view.say(t('working')),
    reportError: error => view.say(error instanceof Error && error.name !== 'AbortError'
      ? error.message : t('connectionInterruptedRefreshToCheckWhetherTheOperationCompleted'), true) });
  const client = createCentralApi({
    csrf: app.getAttribute('data-csrf'),
    sourceTimeoutMs: Number(app.getAttribute('data-source-timeout-ms')),
    t, isCurrent,
    refreshRequired: scope => {
      return uncertain.has(scope) || !(scope === 'skills' ? skillsReady : profilesReady);
    },
    requireRefresh: scope => {
      uncertain.set(scope, {});
      (scope === 'skills' ? skillView : view).invalidate(scope);
    }
  });
  const services = createServiceWorkflow({ app, api: client.request, view, t, refresh: refreshProfiles,
    run: runService, getProfiles: () => profiles,
    navigate: url => { if (isCurrent()) navigate(url); } });
  const skillWorkflow = createSkillWorkflow({ app, api: client.request, view: skillView, t,
    refresh: refreshSkills, run: runSkill, getSkills: () => skills });
  bindRegistryImport({ app, api: client.request, view, t, run: runService });
  app.querySelector('[data-service-create]')?.setAttribute('data-operation-scope', 'mcp-create');
  app.querySelector('[data-registry-import]')?.setAttribute('data-operation-scope', 'mcp-create');
  app.querySelector('[data-central-panel="skills"]')?.setAttribute('data-operation-scope', 'skills');
  const refreshButton = app.querySelector('[data-product-refresh]');
  refreshButton.setAttribute('data-operation-scope', 'library');
  function isCurrent() { return app.isConnected && pageIsCurrent(); }
  function reconciliation(scope) {
    const observed = [...uncertain].filter(([key]) => scope === 'skills' ? key === scope : key !== 'skills');
    return () => { for (const [key, marker] of observed) if (uncertain.get(key) === marker) uncertain.delete(key); };
  }
  function refreshProfiles({ silent = false, background = false } = {}) {
    const read = async () => {
      const reconciled = reconciliation('mcp');
      let listed;
      try { listed = await client.list('profiles'); }
      catch (error) { profilesReady = false; throw error; }
      profiles = listed;
      services.render(profiles);
      operations.sync();
      reconciled();
      profilesReady = true;
      if (!silent && !background) view.say(t('libraryIsUpToDate'));
      return profiles;
    };
    const result = profileReads.then(read);
    profileReads = result.catch(() => {});
    return result;
  }
  function refreshSkills({ silent = false } = {}) {
    const read = async () => {
      const reconciled = reconciliation('skills');
      skillView.invalidate();
      try { skills = app.getAttribute('data-skills') === 'true' ? await client.list('skills') : []; }
      catch (error) { skillsReady = false; throw error; }
      skillWorkflow.render(skills);
      operations.sync();
      reconciled();
      skillsReady = true;
      if (!silent) skillView.say(t('libraryIsUpToDate'));
      return skills;
    };
    const result = skillReads.then(read);
    skillReads = result.catch(() => {});
    return result;
  }
  async function refresh() {
    view.invalidate();
    const reads = [refreshProfiles({ silent: true }), refreshSkills({ silent: true })];
    try { await Promise.all(reads); }
    catch (error) {
      // Keep the library lock until the sibling read settles, preserving the
      // first failure without admitting duplicate refreshes behind a slow read.
      await Promise.allSettled(reads);
      throw error;
    }
    view.say(t('libraryIsUpToDate'));
  }
  refreshButton.addEventListener('click', () => operations.run(refresh, 'library'));
  app.addEventListener('input', () => operations.interacted());
  app.addEventListener('change', () => operations.interacted());
  app.querySelectorAll('[data-central-tab]').forEach(tab => {
    tab.addEventListener('click', () => { operations.interacted(); view.showTab(tab.getAttribute('data-central-tab')); });
  });
  operations.run(async () => {
    await refresh();
    if (!isCurrent()) return;
    const connected = new URL(location.href).searchParams.get('connected');
    if (connected) replaceCurrentUrl('/admin/central');
    // Start after the initial collection lock is released; recovery owns each MCP separately.
    return { connected };
  }, 'library').then(result => {
    const activity = operations.activity();
    if (result && isCurrent()) void services.resumePending(profiles, result.connected,
      () => isCurrent() && operations.activity() === activity);
  });
}
