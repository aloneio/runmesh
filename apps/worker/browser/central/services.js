import { createServiceInspection } from './service-inspection.js';
import { serviceOperationScope } from './request-contract.js';

/** Service connection, OAuth handoff and automatic publication use injected UI/API ports. */
export function createServiceWorkflow({
  app,
  api,
  view,
  t,
  refresh,
  run,
  getProfiles,
  navigate
}) {
  const {
    el,
    say,
    button: viewButton,
    clear
  } = view;
  const recoveryMessages = new Map(), messageNodes = new Map();
  // OAuth redirects share the whole page even though MCP work is scoped per connection.
  // Capture the intent before any creation, enabling or discovery can await a response.
  let authorizationGeneration = 0;
  const authorizationIntent = authentication => authentication === 'oauth' ? ++authorizationGeneration : null;
  function recoveryMessage(id, text, error = false) {
    recoveryMessages.set(id, { text, error });
    const node = messageNodes.get(id);
    if (node) { node.textContent = text; node.hidden = !text; node.setAttribute('data-error', String(error)); }
  }
  const toolsPanel = app.querySelector('[data-service-tools]');
  let toolsGeneration = 0, toolsOwner;
  function clearTools() {
    if (toolsPanel) { clear(toolsPanel); toolsPanel.hidden = true; }
  }
  view.onInvalidate(scope => {
    if (scope && scope !== toolsOwner) return;
    toolsGeneration++; toolsOwner = undefined; clearTools();
  });
  function selectTools(profile) {
    toolsOwner = serviceOperationScope(profile.profile_id);
    clearTools();
    return ++toolsGeneration;
  }
  const inspection = createServiceInspection({ app, api, view, t, run });
  function renderProfiles(profiles) {
    var list = app.querySelector('[data-service-list]');
    clear(list);
    messageNodes.clear();
    if (!profiles.length) list.append(el('p', t('noServicesYetConnectYourFirstServiceToGet'), 'muted'));
    profiles.forEach(function (profile) {
      const scope = serviceOperationScope(profile.profile_id);
      const button = (parent, label, action) => viewButton(parent, label, async () => {
        recoveryMessage(profile.profile_id, '');
        return action();
      }, scope);
      var card = el('article', undefined, 'central-card');
      card.setAttribute('data-operation-scope', scope);
      card.append(el('h3', profile.display_name || profile.connector_id), el('p', profile.endpoint, 'muted'), el('p', profile.enabled ? t('enabled') : t('paused')));
      var actions = el('div', undefined, 'actions');
      button(actions, t('viewTools'), function () {
        return showTools(profile);
      });
      var check = button(actions, t('checkConnection'), () => inspection.inspect({ profile_id: profile.profile_id }));
      check.disabled = !profile.enabled;
      var discover = button(actions, t('refreshTools'), function () {
        return connectService(profile);
      });
      discover.disabled = !profile.enabled;
      button(actions, profile.enabled ? t('pause') : t('enable'), async function () {
        view.invalidate(scope);
        const selection = profile.enabled ? undefined : selectTools(profile);
        const authorization = profile.enabled ? null : authorizationIntent(profile.authentication);
        var result = await api('profiles/' + encodeURIComponent(profile.profile_id), {
          action: profile.enabled ? 'disable' : 'enable',
          expected_revision: profile.revision
        });
        await refresh();
        if (result.profile.enabled) await connectService(result.profile, { selection, authorization });
      });
      card.append(actions);
      if (profile.authentication === 'oauth') {
        var reconnect = button(actions, t('reconnect'), function () {
          return connectOAuth(profile);
        });
        reconnect.disabled = !profile.enabled;
        button(actions, t('disconnectAccount'), async function () {
          view.invalidate(scope);
          await api('connections/revoke', {
            profile_id: profile.profile_id,
            expected_revision: profile.revision
          });
          await refresh();
          say(t('accountDisconnectedReconnectToUseThisService'));
        });
      }
      if (!profile.enabled) card.append(el('p', profile.authentication === 'oauth' ? t('enableThisServiceBeforeCheckingItsConnectionOrReconnecting') : t('enableThisServiceBeforeCheckingItsConnection'), 'muted'));
      const message = recoveryMessages.get(profile.profile_id), status = el('p', message?.text ?? '', 'muted');
      status.hidden = !message?.text;
      status.setAttribute('data-service-status', profile.profile_id);
      status.setAttribute('role', 'status');
      status.setAttribute('data-error', String(message?.error ?? false));
      messageNodes.set(profile.profile_id, status);
      card.append(status);
      list.append(card);
    });
  }
  function isPublished(catalog) {
    return catalog && catalog.head.approved_digest === catalog.snapshot.digest
      && catalog.head.approved_names.length === catalog.snapshot.tools.length
      && catalog.snapshot.tools.every(tool => catalog.head.approved_names.includes(tool.definition.name));
  }
  async function connectService(profile, { catalog: observedCatalog, authorize = true, background = false, mayPresent = () => false,
    selection = background ? undefined : selectTools(profile),
    authorization = authorize && !background ? authorizationIntent(profile.authentication) : null } = {}) {
    var id = encodeURIComponent(profile.profile_id),
      catalog = observedCatalog === undefined ? await api('catalogs/' + id, undefined, true) : observedCatalog;
    var result = await api('discovery/' + id, {
      expected_revision: catalog ? catalog.head.revision : 0
    });
    if (result.state === 'authorization_required') {
      if (authorize && profile.authentication === 'oauth') return connectOAuth(profile, authorization);
      throw new Error(t('signInToThisServiceAgainUsingReconnect'));
    }
    var currentProfiles = await refresh({ background }),
      current = currentProfiles.find(item => item.profile_id === profile.profile_id);
    if (!current || !current.enabled) throw new Error(t('serviceNoLongerEnabled'));
    var published = background ? await api('catalogs/' + id, undefined, true) : await showTools(current, undefined, selection);
    if (!isPublished(published)) throw new Error(t('toolsNotReadyRefreshToConnect'));
    if (background) {
      recoveryMessage(profile.profile_id, t('serviceConnectedToolsReady'));
      if (mayPresent()) { await showTools(current, published); say(t('serviceConnectedToolsReady')); }
    } else if (selection === toolsGeneration) say(t('serviceConnectedToolsReady'));
    return currentProfiles;
  }
  async function resumePending(profiles, connected, mayPresent = () => false) {
    const ids = profiles.map(profile => profile.profile_id);
    if (ids.includes(connected)) {
      ids.splice(ids.indexOf(connected), 1);
      ids.unshift(connected);
    }
    let stopped = false;
    const failures = [];
    function failed(id, error) {
      recoveryMessage(id, error.message, true);
      const profile = (getProfiles ? getProfiles() : profiles).find(item => item.profile_id === id);
      failures.push((profile?.display_name || profile?.connector_id || id) + ': ' + error.message);
      if (mayPresent()) say(t('someServicesNeedAttention') + '\n' + failures.join('\n'), true);
    }
    for (const id of ids) {
      if (stopped) break;
      await run(async () => {
        const profile = (getProfiles ? getProfiles() : profiles).find(item => item.profile_id === id);
        if (!profile?.enabled) return;
        try {
          const catalog = await api('catalogs/' + encodeURIComponent(id), undefined, true);
          if (id !== connected && isPublished(catalog)) return;
          recoveryMessage(id, t('working'));
          // An OAuth return continues discovery, without starting another sign-in.
          profiles = await connectService(profile, { catalog, authorize: false, background: true, mayPresent });
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          failed(id, error);
          // Reconcile this result before releasing the connection or continuing recovery.
          try { profiles = await refresh({ silent: true, background: true }); }
          catch (refreshError) { stopped = true; throw refreshError; }
        }
      }, serviceOperationScope(id), { background: true, onError: error => failed(id, error) });
    }
    if (failures.length && mayPresent()) say(t('someServicesNeedAttention') + '\n' + failures.join('\n'), true);
  }
  async function showTools(profile, observedCatalog, selection = selectTools(profile)) {
    var catalog = observedCatalog === undefined ? await api('catalogs/' + encodeURIComponent(profile.profile_id), undefined, true) : observedCatalog,
      panel = toolsPanel;
    if (selection !== toolsGeneration) return catalog;
    clear(panel);
    panel.hidden = false;
    var heading = el('div', undefined, 'section-title');
    heading.append(el('h2', profile.display_name || profile.connector_id));
    panel.append(heading);
    if (!catalog) {
      panel.append(el('p', t('noToolsDiscoveredYetEnableTheServiceThenCheck')));
      say(t('noCatalogYet'));
      return null;
    }
    heading.append(el('span', catalog.snapshot.tools.length + ' ' + t(catalog.snapshot.tools.length === 1 ? 'toolCountOne' : 'toolCount'), 'muted'));
    if (!profile.enabled || !isPublished(catalog)) panel.append(el('p', t(!profile.enabled ? 'serviceNoLongerEnabled' : 'toolsNotReadyRefreshToConnect')));
    catalog.snapshot.tools.forEach(function (tool) {
      var card = el('article', undefined, 'central-card');
      card.append(el('h3', tool.definition.title || tool.definition.name));
      if (tool.definition.description) card.append(el('p', tool.definition.description, 'muted'));
      panel.append(card);
    });
    if (!catalog.snapshot.tools.length) panel.append(el('p', t('serviceHasNoTools')));
    panel.scrollIntoView({
      block: 'nearest'
    });
    say(t('toolsReadyToView'));
    return catalog;
  }
  async function connectOAuth(profile, authorization = authorizationIntent(profile.authentication)) {
    const currentIntent = () => authorization === authorizationGeneration;
    if (!currentIntent()) return getProfiles?.() ?? [];
    view.invalidate(serviceOperationScope(profile.profile_id));
    say(t('openingTheServiceSignInPage'));
    // Reconcile a failed discovery or earlier handoff before starting a new one.
    // Use the refreshed revision so a paused or removed MCP cannot reconnect.
    try {
      var currentProfiles = await refresh({ silent: true });
      if (!currentIntent()) return currentProfiles;
      const current = currentProfiles.find(item => item.profile_id === profile.profile_id);
      if (!current || !current.enabled || current.authentication !== 'oauth') throw new Error(t('serviceNoLongerEnabled'));
      var result = await api('connections/begin', {
        profile_id: current.profile_id,
        expected_revision: current.revision
      });
      if (currentIntent()) navigate(result.authorization_url);
      return currentProfiles;
    } catch (error) {
      // Superseded responses still pass API receipt/reconciliation checks, but do
      // not replace the latest authorization's feedback or revive its predecessor.
      if (!currentIntent()) return getProfiles?.() ?? [];
      throw error;
    }
  }
  app.querySelector('[data-service-create]').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    run(async function () {
      var endpoint = form.elements.endpoint.value.trim(),
        authentication = form.elements.authentication.value,
        name = form.elements.name.value.trim();
      if (!name) {
        name = new URL(endpoint).hostname;
        var limit = form.elements.name.maxLength;
        if (name.length > limit) name = name.slice(0, limit - 1) + '…';
      }
      var id = 'service-' + crypto.randomUUID();
      const authorization = authorizationIntent(authentication);
      await run(async () => {
        view.invalidate('mcp-create');
        const selection = authentication === 'none' ? selectTools({ profile_id: id }) : undefined;
        var result = await api('profiles/' + id, {
          action: 'connect',
          connector_id: id,
          display_name: name,
          endpoint: endpoint,
          authentication: authentication
        });
        form.reset();
        var enabled = await api('profiles/' + id, {
          action: 'enable',
          expected_revision: result.profile.revision
        });
        await refresh();
        if (authentication === 'oauth') {
          await connectOAuth(enabled.profile, authorization);
          return;
        }
        await connectService(enabled.profile, { selection });
      }, serviceOperationScope(id), { onError: error => { throw error; } });
    });
  });
  return {
    render: renderProfiles,
    resumePending
  };
}
