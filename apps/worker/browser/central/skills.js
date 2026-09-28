/** Skill selection and review have no knowledge of service or controller internals. */
export function createSkillWorkflow({
  app,
  api,
  view,
  t,
  refresh,
  run,
  getSkills
}) {
  const {
    el,
    say,
    button,
    clear,
    details
  } = view;
  function renderSkills(skills) {
    var list = app.querySelector('[data-skill-list]');
    if (!list) return;
    clear(list);
    if (!skills.length) list.append(el('p', t('noSkillsYetImportASkillToReviewAnd'), 'muted'));
    skills.forEach(function (item) {
      var card = el('article', undefined, 'central-card'),
        head = item.head;
      card.append(el('h3', item.summary.name), el('p', item.summary.description), el('p', head.enabled ? t('installed') : t('paused')));
      if (head.enabled && head.staged_digest !== head.active_digest) card.append(el('p', t('anUpdateIsAwaitingReview')));
      var actions = el('div', undefined, 'actions');
      button(actions, t('viewFiles'), async function () {
        var data = await api('skills/' + encodeURIComponent(head.skill_id));
        showSkill(data.bundle, data.head);
      });
      if (head.enabled) button(actions, t('pause'), async function () {
        await api('skills/' + encodeURIComponent(head.skill_id), {
          action: 'disable',
          expected_revision: head.revision
        });
        await refresh();
      });
      card.append(actions);
      list.append(card);
    });
  }
  function showSkill(bundle, head) {
    var panel = app.querySelector('[data-skill-review]');
    clear(panel);
    panel.hidden = false;
    panel.append(el('h2', bundle.name), el('p', bundle.description));
    bundle.files.forEach(function (file) {
      details(panel, file.path, file.text);
    });
    if (bundle.required_capabilities && bundle.required_capabilities.length) details(panel, t('requiredCapabilitiesMustBePublishedAndEnabled'), JSON.stringify(bundle.required_capabilities, null, 2));
    if (!head.enabled || head.active_digest !== bundle.digest) button(panel, head.enabled ? t('publishUpdate') : t('enableSkill'), async function () {
      await api('skills/' + encodeURIComponent(head.skill_id), {
        action: 'activate',
        expected_revision: head.revision,
        digest: bundle.digest
      });
      await refresh();
    });
    panel.scrollIntoView({
      block: 'nearest'
    });
    say(t('skillFilesAreReadyToReview'));
  }
  var importer = app.querySelector('[data-skill-import]');
  if (importer) ['files', 'folder'].forEach(function (name) {
    importer.elements[name].addEventListener('change', function () {
      if (this.files.length) importer.elements[name === 'files' ? 'folder' : 'files'].value = '';
      var panel = app.querySelector('[data-skill-review]');
      if (!panel.hidden) {
        clear(panel);
        panel.hidden = true;
        say(t('selectionChangedCheckTheFilesAndSelectInstallSkill'));
      }
    });
  });
  if (importer) importer.addEventListener('submit', function (event) {
    event.preventDefault();
    run(async function () {
      var picked = Array.from(importer.elements.folder.files.length ? importer.elements.folder.files : importer.elements.files.files);
      if (!picked.length || picked.length > 32 || picked.some(function (f) {
        return f.size > 65536;
      }) || picked.reduce(function (n, f) {
        return n + f.size;
      }, 0) > 262144) throw new Error(t('select132TextFilesUpTo64Kib'));
      var files = [];
      for (var f of picked) {
        var path = f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name;
        var text;
        try {
          text = new TextDecoder('utf-8', {
            fatal: true
          }).decode(await f.arrayBuffer());
        } catch {
          throw new Error(t('couldNotReadTheSelectedFiles'));
        }
        files.push({
          path: path,
          text: text
        });
      }
      var main = files.find(function (f) {
        return f.path === 'SKILL.md';
      });
      if (!main) throw new Error(t('theSelectedFolderMustContainSkillMdAtIts'));
      async function install(revision) {
        var result = await api('skill-installations', {
          files: files,
          expected_revision: revision
        });
        importer.reset();
        await refresh();
        var current = getSkills().find(item => item.head.skill_id === result.skill_id);
        if (!current || !current.head.enabled || current.head.active_digest !== result.digest) throw new Error(t('skillChangedAfterInstallation'));
        say(result.name + t('installedReadyToUseInAllConnectedAiClients'));
      }
      try {
        await install(0);
      } catch (error) {
        if (!error.skillId) throw error;
        await refresh();
        var current = getSkills().find(function (item) {
          return item.head.skill_id === error.skillId;
        });
        if (!current || current.head.revision !== error.revision) throw new Error(t('skillChangedSelectTheFilesAgainToUpdateIt'));
        var panel = app.querySelector('[data-skill-review]');
        clear(panel);
        panel.hidden = false;
        panel.append(el('h2', t('updateInstalledSkill') + current.summary.name), el('p', t('thisUpdatesTheSkillForAllConnectedAiClients')));
        files.forEach(function (file) {
          details(panel, file.path, file.text);
        });
        button(panel, t('updateSkill'), function () {
          return install(current.head.revision);
        });
        button(panel, t('cancel'), async function () {
          clear(panel);
          panel.hidden = true;
          say(t('updateCancelled'));
        });
        say(t('thisSkillIsAlreadyInstalledReviewTheUpdateAnd'));
      }
    });
  });
  return {
    render: renderSkills
  };
}
