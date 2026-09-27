/** Service connection, OAuth handoff and automatic publication use injected UI/API ports. */
export function createServiceWorkflow({
  app,
  api,
  view,
  t,
  refresh,
  run,
  navigate
}) {
  const {
    el,
    say,
    button,
    clear,
    details
  } = view;
  function renderProfiles(profiles) {
    var list = app.querySelector('[data-service-list]');
    clear(list);
    if (!profiles.length) list.append(el('p', t('noServicesYetConnectYourFirstServiceToGet'), 'muted'));
    profiles.forEach(function (profile) {
      var card = el('article', undefined, 'central-card');
      card.append(el('h3', profile.display_name || profile.connector_id), el('p', profile.endpoint, 'muted'), el('p', profile.enabled ? t('enabled') : t('paused')));
      var actions = el('div', undefined, 'actions');
      button(actions, t('viewTools'), function () {
        return showTools(profile);
      });
      var discover = button(actions, t('refreshTools'), function () {
        return connectService(profile);
      });
      discover.disabled = !profile.enabled;
      button(actions, profile.enabled ? t('pause') : t('enable'), async function () {
        var result = await api('profiles/' + encodeURIComponent(profile.profile_id), {
          action: profile.enabled ? 'disable' : 'enable',
          expected_revision: profile.revision
        });
        await refresh();
        if (result.profile.enabled) await connectService(result.profile);
      });
      card.append(actions);
      if (profile.authentication === 'oauth') {
        var reconnect = button(actions, t('reconnect'), function () {
          return connectOAuth(profile);
        });
        reconnect.disabled = !profile.enabled;
        button(actions, t('disconnectAccount'), async function () {
          await api('connections/revoke', {
            profile_id: profile.profile_id,
            expected_revision: profile.revision
          });
          await refresh();
          say(t('accountDisconnectedReconnectToUseThisService'));
        });
      }
      if (!profile.enabled) card.append(el('p', profile.authentication === 'oauth' ? t('enableThisServiceBeforeCheckingItsConnectionOrReconnecting') : t('enableThisServiceBeforeCheckingItsConnection'), 'muted'));
      list.append(card);
    });
  }
  function isPublished(catalog) {
    return catalog && catalog.head.approved_digest === catalog.snapshot.digest
      && catalog.head.approved_names.length === catalog.snapshot.tools.length
      && catalog.snapshot.tools.every(tool => catalog.head.approved_names.includes(tool.definition.name));
  }
  async function connectService(profile) {
    var id = encodeURIComponent(profile.profile_id),
      catalog = await api('catalogs/' + id, undefined, true);
    await api('discovery/' + id, {
      expected_revision: catalog ? catalog.head.revision : 0
    });
    var currentProfiles = await refresh(),
      current = currentProfiles.find(item => item.profile_id === profile.profile_id);
    if (!current || !current.enabled) throw new Error(t('serviceNoLongerEnabled'));
    var published = await showTools(current);
    if (!isPublished(published)) throw new Error(t('toolsNotReadyRefreshToConnect'));
    say(t('serviceConnectedToolsReady'));
    return currentProfiles;
  }
  async function resumePending(profiles, connected) {
    const ids = profiles.map(profile => profile.profile_id);
    if (ids.includes(connected)) {
      ids.splice(ids.indexOf(connected), 1);
      ids.unshift(connected);
    }
    const failures = [];
    var needsRefresh = false;
    function failed(profile, error) {
      if (error.name === 'AbortError') throw error;
      failures.push((profile.display_name || profile.connector_id) + ': ' + error.message);
      needsRefresh = true;
    }
    for (const id of ids) {
      var profile = profiles.find(item => item.profile_id === id), catalog;
      if (!profile || !profile.enabled) continue;
      try {
        catalog = await api('catalogs/' + encodeURIComponent(id), undefined, true);
      } catch (error) {
        failed(profile, error);
        continue;
      }
      if (id !== connected && isPublished(catalog)) continue;
      // Reconcile an uncertain write before a different service can mutate.
      // The original failed service is never retried in this recovery pass.
      if (needsRefresh) {
        profiles = await refresh();
        needsRefresh = false;
        profile = profiles.find(item => item.profile_id === id);
        if (!profile || !profile.enabled) continue;
      }
      try {
        profiles = await connectService(profile);
      } catch (error) {
        failed(profile, error);
      }
    }
    if (failures.length) throw new Error(t('someServicesNeedAttention') + '\n' + failures.join('\n'));
  }
  async function showTools(profile) {
    var catalog = await api('catalogs/' + encodeURIComponent(profile.profile_id), undefined, true),
      panel = app.querySelector('[data-service-tools]');
    clear(panel);
    panel.hidden = false;
    panel.append(el('h2', t('toolsForService') + (profile.display_name || profile.connector_id)));
    if (!catalog) {
      panel.append(el('p', t('noToolsDiscoveredYetEnableTheServiceThenCheck')));
      say(t('noCatalogYet'));
      return null;
    }
    panel.append(el('p', t(!profile.enabled ? 'serviceNoLongerEnabled' : isPublished(catalog) ? 'toolsAvailableAutomatically' : 'toolsNotReadyRefreshToConnect')));
    catalog.snapshot.tools.forEach(function (tool) {
      panel.append(el('h3', tool.definition.title || tool.definition.name), el('p', tool.definition.description || '', 'muted'));
      details(panel, t('parametersSafetyHints'), JSON.stringify({
        input: tool.definition.inputSchema,
        output: tool.definition.outputSchema,
        hints: tool.definition.annotations
      }, null, 2));
    });
    if (!catalog.snapshot.tools.length) panel.append(el('p', t('serviceHasNoTools')));
    panel.scrollIntoView({
      block: 'nearest'
    });
    say(t('toolsReadyToView'));
    return catalog;
  }
  async function connectOAuth(profile) {
    var result = await api('connections/begin', {
      profile_id: profile.profile_id,
      expected_revision: profile.revision
    });
    say(t('openingTheServiceSignInPage'));
    navigate(result.authorization_url);
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
      var result = await api('profiles/' + id, {
        action: 'connect',
        connector_id: id,
        display_name: name,
        endpoint: endpoint,
        authentication: authentication
      });
      var enabled = await api('profiles/' + id, {
        action: 'enable',
        expected_revision: result.profile.revision
      });
      form.reset();
      if (authentication === 'oauth') {
        await connectOAuth(enabled.profile);
        return;
      }
      await refresh();
      await connectService(enabled.profile);
    });
  });
  return {
    render: renderProfiles,
    resumePending
  };
}
