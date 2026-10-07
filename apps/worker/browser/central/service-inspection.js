import { serviceOperationScope } from './request-contract.js';

/** A connection check displays server declarations without changing a connection. */
export function createServiceInspection({ app, api, view, t, run }) {
  const { el, clear, say } = view;
  const panel = app.querySelector('[data-service-inspection]');
  const form = app.querySelector('[data-service-create]');
  let generation = 0, owner;
  function invalidate(scope) {
    if (scope && scope !== owner) return;
    generation++; owner = undefined;
    if (panel) { clear(panel); panel.hidden = true; }
  }
  view.onInvalidate(invalidate);
  form?.elements?.endpoint?.addEventListener?.('input', () => invalidate('mcp-create'));
  form?.elements?.authentication?.addEventListener?.('change', () => invalidate('mcp-create'));
  async function inspect(input) {
    if (!panel) return;
    invalidate();
    owner = input.profile_id ? serviceOperationScope(input.profile_id) : 'mcp-create';
    const current = generation;
    const result = await api('connection-check', input);
    if (current !== generation) return;
    panel.hidden = false;
    const heading = el('h2', t('connectionCheckResult'));
    heading.tabIndex = -1;
    panel.append(heading);
    if (result.state === 'authorization_required') {
      const message = t(input.profile_id ? 'inspectionReconnect' : 'inspectionChooseOAuth');
      panel.append(el('p', message));
      say(message);
    } else {
      panel.append(el('p', result.endpoint, 'muted'), el('p', t('inspectionProtocol', { version: result.server.protocol_version })));
      const caps = result.server.capabilities;
      if (caps.tools) panel.append(el('p', t('inspectionToolsChecked', { count: result.tools_count })));
      else panel.append(el('p', t('inspectionHandshakeComplete')));
      const declarations = el('ul');
      for (const key of ['resources', 'prompts', 'tasks', 'apps']) {
        if (caps[key]) declarations.append(el('li', t('inspectionCapability_' + key) + ' · ' + t('inspectionDeclared')));
      }
      if (declarations.children.length) panel.append(declarations);
      if (caps.tools) panel.append(el('p', t('inspectionToolConnection'), 'muted'));
      say(t('inspectionComplete'));
    }
    heading.focus?.({ preventScroll: true });
    heading.scrollIntoView?.({ block: 'nearest' });
  }
  app.querySelector('[data-service-check]')?.addEventListener('click', () => {
    if (form.elements.endpoint.reportValidity && !form.elements.endpoint.reportValidity()) return;
    run(() => inspect({ endpoint: form.elements.endpoint.value.trim() }));
  });
  return { inspect };
}
