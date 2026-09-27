/** Service connection, OAuth handoff and catalog review use only injected UI/API ports. */
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
    details,
    choice
  } = view;
  function renderProfiles(profiles) {
    var list = app.querySelector('[data-service-list]');
    clear(list);
    if (!profiles.length) list.append(el('p', t('noServicesYetConnectYourFirstServiceToGet'), 'muted'));
    profiles.forEach(function (profile) {
      var card = el('article', undefined, 'central-card');
      card.append(el('h3', profile.display_name || profile.connector_id), el('p', profile.endpoint, 'muted'), el('p', profile.enabled ? t('enabledToolReviewRequiredBeforeSharing') : t('paused')));
      var actions = el('div', undefined, 'actions');
      button(actions, t('reviewTools'), function () {
        return reviewService(profile, false);
      });
      var discover = button(actions, t('checkConnectionDiscover'), function () {
        return reviewService(profile, true);
      });
      discover.disabled = !profile.enabled;
      button(actions, profile.enabled ? t('pause') : t('enable'), async function () {
        await api('profiles/' + encodeURIComponent(profile.profile_id), {
          action: profile.enabled ? 'disable' : 'enable',
          expected_revision: profile.revision
        });
        await refresh();
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
  async function reviewService(profile, discover) {
    var id = encodeURIComponent(profile.profile_id),
      catalog = await api('catalogs/' + id, undefined, true);
    if (discover) {
      await api('discovery/' + id, {
        expected_revision: catalog ? catalog.head.revision : 0
      });
      catalog = await api('catalogs/' + id);
    }
    var panel = app.querySelector('[data-service-review]');
    clear(panel);
    panel.hidden = false;
    panel.append(el('h2', t('reviewTools2') + (profile.display_name || profile.connector_id)));
    if (!catalog) {
      panel.append(el('p', t('noToolsDiscoveredYetEnableTheServiceThenCheck')));
      say(t('noCatalogYet'));
      return;
    }
    panel.append(el('p', t('approvedToolsAreAvailableToAllConnectedAiClients')));
    var selected = catalog.snapshot.tools.map(function (tool) {
      var delta = catalog.changes.find(function (c) {
        return c.name === tool.definition.name;
      });
      var changed = delta && delta.state !== 'unchanged';
      var box = choice(panel, tool.definition.title || tool.definition.name, (changed ? t('newOrChanged') : '') + (tool.definition.description || ''), catalog.head.approved_digest === catalog.snapshot.digest && catalog.head.approved_names.includes(tool.definition.name));
      details(panel, t('parametersSafetyHints'), JSON.stringify({
        input: tool.definition.inputSchema,
        output: tool.definition.outputSchema,
        hints: tool.definition.annotations
      }, null, 2));
      return {
        box: box,
        name: tool.definition.name
      };
    });
    catalog.changes.filter(function (c) {
      return c.state === 'removed';
    }).forEach(function (c) {
      panel.append(el('p', t('removed') + c.name));
    });
    button(panel, t('approveSelectedTools'), async function () {
      await api('catalogs/' + id, {
        action: 'approve',
        expected_revision: catalog.head.revision,
        digest: catalog.snapshot.digest,
        tool_names: selected.filter(function (s) {
          return s.box.checked;
        }).map(function (s) {
          return s.name;
        }).sort()
      });
      await refresh();
      say(t('toolsApprovedRefreshTheToolListInYourAi'));
    });
    panel.scrollIntoView({
      block: 'nearest'
    });
    say(t('reviewTheToolsBeforeApproving'));
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
        name = form.elements.name.value.trim() || new URL(endpoint).hostname;
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
      await reviewService(enabled.profile, true);
    });
  });
  return {
    render: renderProfiles,
    review: reviewService
  };
}
