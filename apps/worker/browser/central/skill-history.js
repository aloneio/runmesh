/** Version management owns only its snapshot and confirmations, never library state. */
export function createSkillHistory({ app, api, view, t, refresh, inspect, getSkills }) {
  const { el, button, clear, details, say } = view;
  const panel = app.querySelector('[data-skill-history]');
  let generation = 0;
  function invalidate() {
    generation++;
    if (panel) { clear(panel); panel.hidden = true; }
  }
  view.onInvalidate(invalidate);
  function focus(node) {
    node.tabIndex = -1;
    node.focus?.({ preventScroll: true });
    node.scrollIntoView?.({ block: 'nearest' });
  }
  function bytes(value) {
    return value < 1048576 ? (value / 1024).toFixed(1) + ' KiB' : (value / 1048576).toFixed(1) + ' MiB';
  }
  async function open(skillId, name) {
    if (!panel) return;
    invalidate();
    const current = generation;
    const path = 'skills/' + encodeURIComponent(skillId);
    const data = await api(path + '/versions');
    if (current !== generation) return;
    const { head, capacity, versions } = data;
    panel.hidden = false;
    const heading = el('h2', t('skillHistoryTitle', { name }));
    panel.append(heading, el('p', t('skillVersionCapacity', { count: capacity.skill_versions, max: capacity.max_versions, bytes: bytes(capacity.skill_bytes) })),
      el('p', t('skillLibraryCapacity', { count: capacity.library_skills, max: capacity.max_skills, bytes: bytes(capacity.library_bytes), limit: bytes(capacity.max_library_bytes) }), 'muted'));
    if (capacity.skill_versions >= capacity.max_versions) panel.append(el('p', t('skillVersionLimitCleanup')));
    const selected = new Set();
    const confirmation = el('section');
    const comparison = el('section');
    let confirmationEpoch = 0;
    function clearConfirmation() { confirmationEpoch++; clear(confirmation); }
    function assertCurrent() {
      if (current !== generation || panel.hidden) throw new Error(t('skillHistoryChanged'));
    }
    function action(fn) {
      return async () => {
        try { assertCurrent(); await fn(); }
        catch (error) { invalidate(); throw error; }
      };
    }
    function review(kind, label, commit) {
      clearConfirmation();
      const epoch = confirmationEpoch;
      const title = el('h3', kind);
      confirmation.append(title, el('p', label));
      const actions = el('div', undefined, 'actions');
      button(actions, t('confirm'), action(async () => {
        if (epoch !== confirmationEpoch) throw new Error(t('skillHistoryChanged'));
        clearConfirmation();
        await commit();
      }));
      button(actions, t('cancel'), async () => { clearConfirmation(); focus(heading); });
      confirmation.append(actions);
      focus(title);
    }
    const versionList = el('div', undefined, 'central-list');
    const cleanupActions = el('div', undefined, 'actions');
    const preview = button(cleanupActions, t('previewSkillCleanup'), action(async () => {
      clearConfirmation();
      if (!selected.size) return;
      const result = await api(path + '/cleanup-preview', { digests: [...selected], expected_revision: head.revision });
      assertCurrent();
      const plan = result.plan;
      review(t('confirmSkillCleanup'), t('skillCleanupSummary', { count: plan.digests.length, bytes: bytes(plan.bytes) }), async () => {
        if (plan.expires_at_ms <= Date.now()) throw new Error(t('skillCleanupExpired'));
        const receipt = await api(path + '/cleanup', { fingerprint: plan.fingerprint, expected_revision: plan.revision, confirm: true });
        const matchesPlan = receipt.freed_bytes === plan.bytes && receipt.deleted_digests.length === plan.digests.length
          && plan.digests.every(digest => receipt.deleted_digests.includes(digest));
        await refresh();
        if (!matchesPlan) throw new Error(t('unexpectedResponseRefreshBeforeMakingAnotherChange'));
        await open(skillId, name);
        say(t('skillCleanupComplete'));
      });
      details(confirmation, t('skillCleanupVersions'), plan.digests.join('\n'));
    }));
    preview.disabled = true;
    for (const version of versions) {
      const card = el('article', undefined, 'central-card');
      const label = version.digest.slice(0, 12);
      card.append(el('h3', label));
      const flags = [version.active && t('activeSkillVersion'), version.staged && t('latestSkillVersion'), version.pinned && t('pinnedSkillVersion')].filter(Boolean);
      card.append(el('p', [flags.join(' · '), t('skillVersionFiles', { count: version.file_count, bytes: bytes(version.bytes) })].filter(Boolean).join(' · '), 'muted'));
      if (version.created_at_ms !== null) {
        const time = el('time', new Date(version.created_at_ms).toLocaleString(document.documentElement.lang));
        time.dateTime = new Date(version.created_at_ms).toISOString();
        card.append(time);
      }
      const actions = el('div', undefined, 'actions');
      button(actions, t('viewFiles'), action(() => inspect(skillId, version.digest)));
      button(actions, t(version.pinned ? 'unpinSkillVersion' : 'pinSkillVersion'), action(async () => {
        clearConfirmation();
        await api(path + '/retention', { digest: version.digest, pinned: !version.pinned, expected_revision: head.revision });
        await refresh();
        const latest = await open(skillId, name);
        if (latest?.versions.find(item => item.digest === version.digest)?.pinned !== !version.pinned) throw new Error(t('skillHistoryChanged'));
        say(t(version.pinned ? 'skillVersionUnpinned' : 'skillVersionPinned'));
      }));
      if (!head.enabled || !version.active) button(actions, t('restoreSkillVersion'), action(async () => {
        review(t('restoreSkillVersion'), t('skillRestoreSummary', { digest: label }), async () => {
          await api(path, { action: 'activate', expected_revision: head.revision, digest: version.digest });
          await refresh();
          const latest = getSkills().find(item => item.head.skill_id === skillId)?.head;
          if (!latest?.enabled || latest.active_digest !== version.digest) throw new Error(t('skillChangedAfterInstallation'));
          say(t('skillVersionRestored'));
        });
      }));
      if (!version.active && !version.staged && !version.pinned) {
        const choice = el('label', undefined, 'check');
        const checkbox = el('input');
        checkbox.type = 'checkbox';
        checkbox.addEventListener('change', () => {
          clearConfirmation();
          if (checkbox.checked) selected.add(version.digest); else selected.delete(version.digest);
          preview.disabled = selected.size === 0;
        });
        choice.append(checkbox, el('span', t('selectSkillVersionCleanup', { digest: label })));
        card.append(choice);
      }
      card.append(actions);
      versionList.append(card);
    }
    panel.append(versionList, cleanupActions);
    if (versions.length > 1) {
      const compareForm = el('div', undefined, 'connection-form');
      function versionSelect(key, initial) {
        const label = el('label', t(key));
        const select = el('select');
        for (const version of versions) {
          const option = el('option', version.digest.slice(0, 12));
          option.value = version.digest;
          select.append(option);
        }
        select.value = initial;
        select.addEventListener('change', () => { clearConfirmation(); clear(comparison); });
        label.append(select);
        compareForm.append(label);
        return select;
      }
      const before = versionSelect('skillCompareBefore', head.active_digest ?? versions[0].digest);
      const after = versionSelect('skillCompareAfter', versions.find(version => version.digest !== before.value).digest);
      button(compareForm, t('compareSkillVersions'), action(async () => {
        clearConfirmation();
        clear(comparison);
        const diff = await api(path + '/compare', { before: before.value, after: after.value });
        assertCurrent();
        if (diff.revision !== head.revision) throw new Error(t('skillHistoryChanged'));
        const title = el('h3', t('skillVersionChanges'));
        comparison.append(title);
        if (!diff.files.length && !diff.metadata.length) comparison.append(el('p', t('skillVersionsMatch')));
        for (const field of diff.metadata) details(comparison, t('skillMetadata_' + field.field), t('skillCompareBefore') + '\n' + field.before + '\n\n' + t('skillCompareAfter') + '\n' + field.after);
        for (const file of diff.files) {
          comparison.append(el('h4', file.path + ' · ' + t('skillFile_' + file.change)));
          if (file.before_text !== undefined) details(comparison, t('skillCompareBefore'), file.before_text);
          if (file.after_text !== undefined) details(comparison, t('skillCompareAfter'), file.after_text);
          if (file.truncated) comparison.append(el('p', t('skillDiffTruncated'), 'muted'));
        }
        if (diff.truncated && !diff.files.some(file => file.truncated)) comparison.append(el('p', t('skillDiffTruncated'), 'muted'));
        const actions = el('div', undefined, 'actions');
        button(actions, t('viewBeforeFiles'), action(() => inspect(skillId, diff.before)));
        button(actions, t('viewAfterFiles'), action(() => inspect(skillId, diff.after)));
        comparison.append(actions);
        focus(title);
      }));
      panel.append(compareForm);
    }
    panel.append(confirmation, comparison);
    focus(heading);
    say(t('skillHistoryLoaded'));
    return data;
  }
  return { open, invalidate };
}
