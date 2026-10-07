/** A source preview is bound to one form selection and one installed revision. */
export function bindSkillSource({ app, api, view, t, refresh, run, getSkills, openHistory }) {
  const form = app.querySelector('[data-skill-source]');
  const panel = app.querySelector('[data-skill-source-preview]');
  if (!form || !panel) return;
  const { el, clear, details, button, say } = view;
  let generation = 0;
  function invalidate() { generation++; clear(panel); panel.hidden = true; }
  view.onInvalidate(invalidate);
  for (const name of ['repository', 'commit', 'path']) form.elements[name].addEventListener('input', invalidate);
  const limits = app.querySelector('[data-skill-source-limits]');
  if (limits) limits.textContent = t('skillSourceLimits').replace('{files}', form.dataset.maxFiles);
  form.addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      invalidate();
      const current = generation;
      const source = Object.fromEntries(['repository', 'commit', 'path'].map(key => [key, form.elements[key].value.trim()]));
      try {
        const result = await api('skill-source/preview', { source, expected_revision: 0 });
        if (current !== generation) return;
        const { bundle } = result;
        const installed = getSkills().find(item => item.head.skill_id === bundle.skill_id);
        const revision = installed?.head.revision ?? 0;
        panel.hidden = false;
        const title = el('h2', bundle.name);
        title.tabIndex = -1;
        panel.append(title, el('p', bundle.description), el('p', bundle.source, 'muted'));
        if (bundle.license) panel.append(el('p', t('skillMetadata_license') + ': ' + bundle.license));
        if (installed) panel.append(el('p', t('thisUpdatesTheSkillForAllConnectedAiClients')));
        bundle.files.forEach(file => details(panel, file.path, file.text));
        if (bundle.required_capabilities?.length) details(panel, t('requiredCapabilitiesMustBePublishedAndEnabled'), JSON.stringify(bundle.required_capabilities, null, 2));
        const actions = el('div', undefined, 'actions');
        button(actions, t(installed ? 'updateSkill' : 'installSkill'), async () => {
          if (current !== generation) throw new Error(t('skillSourceChanged'));
          invalidate();
          try {
            const receipt = await api('skill-source/install', { source: result.source, expected_revision: revision, digest: bundle.digest });
            if (receipt.head.skill_id !== bundle.skill_id) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
            await refresh();
            const active = getSkills().find(item => item.head.skill_id === bundle.skill_id);
            if (!active?.head.enabled || active.head.active_digest !== bundle.digest) throw new Error(t('skillChangedAfterInstallation'));
            say(bundle.name + t('installedReadyToUseInAllConnectedAiClients'));
          } catch (error) {
            if (error.skillCapacity && installed) await openHistory(installed.head.skill_id, installed.summary.name);
            throw error;
          }
        });
        button(actions, t('cancel'), async () => { invalidate(); form.elements.repository.focus?.(); });
        panel.append(actions);
        title.focus?.({ preventScroll: true });
        title.scrollIntoView?.({ block: 'nearest' });
        say(t('skillSourceReady'));
      } catch (error) { invalidate(); throw error; }
    });
  });
}
