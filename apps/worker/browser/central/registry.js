/** A registry entry fills the ordinary connection form; it never connects it. */
export function bindRegistryImport({ app, api, view, t, run }) {
  const panel = app.querySelector('[data-registry-import]');
  if (!panel) return;
  const picker = panel.querySelector('[data-registry-file]'), result = panel.querySelector('[data-registry-results]');
  const form = app.querySelector('[data-service-create]');
  let generation = 0;
  const clear = () => { generation++; view.clear(result); };
  view.onInvalidate(scope => { if (!scope || scope === 'mcp-create') clear(); });
  picker.addEventListener('change', clear);
  panel.querySelector('[data-registry-preview]').addEventListener('click', () => run(async () => {
    clear();
    const selected = picker.files[0], limit = Number(panel.dataset.maxBytes);
    if (!selected || !Number.isSafeInteger(limit) || selected.size > limit) throw new Error(t('registryChooseFile'));
    const current = generation;
    let entry;
    try { entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await selected.arrayBuffer())); }
    catch { throw new Error(t('registryInvalidEntry')); }
    const preview = await api('registry-preview', { entry });
    if (current !== generation) return;
    result.append(view.el('h3', preview.name), view.el('p', preview.description), view.el('p', preview.version, 'muted'));
    for (const candidate of preview.remotes) {
      const card = view.el('article', undefined, 'central-card');
      card.append(view.el('p', candidate.endpoint), view.el('p', candidate.transport, 'muted'));
      if (candidate.mode === 'connect') view.button(card, t('registryUseConnection'), async () => {
        if (current !== generation) return;
        form.elements.endpoint.value = candidate.endpoint;
        form.elements.authentication.value = 'none';
        form.elements.name.value = preview.name.slice(-form.elements.name.maxLength);
        form.elements.endpoint.dispatchEvent(new Event('input', { bubbles: true }));
        form.elements.endpoint.focus();
        form.scrollIntoView({ block: 'nearest' });
        view.say(t('registryConnectionReady'));
      });
      else card.append(view.el('p', t('registryConfigureConnection'), 'muted'));
      result.append(card);
    }
    if (preview.packages.length) {
      result.append(view.el('p', t('registryHostedPackages'), 'muted'));
      for (const pkg of preview.packages) result.append(view.el('p', [pkg.registry, pkg.identifier, pkg.version].filter(Boolean).join(' · ')));
    }
    view.say(t('registryPreviewReady'));
  }));
}
