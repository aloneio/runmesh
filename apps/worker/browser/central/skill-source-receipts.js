const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Keep source identity and confirmed publication bound to the reviewed request. */
export function validSkillSourceReceipt(action, body, value) {
  if (action === 'install') return typeof value.head?.skill_id === 'string' && value.head.skill_id.length > 0
    && value.head.revision === body.expected_revision + 1 && value.head.enabled === true
    && digest(value.head.active_digest) && value.head.active_digest === body.digest && value.head.staged_digest === body.digest;
  const { bundle, source } = value;
  const repository = typeof body.source?.repository === 'string' ? body.source.repository.replace(/\/$/, '').replace(/\.git$/, '') : '';
  return source?.repository === repository && source.commit === body.source.commit && source.path === body.source.path
    && /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(source.repository) && /^[a-f0-9]{40}$/.test(source.commit)
    && bundle?.schema_version === 1 && digest(bundle.digest)
    && ['skill_id', 'name', 'description', 'source', 'license'].every(key => typeof bundle[key] === 'string')
    && bundle.skill_id.length > 0 && bundle.name.length > 0
    && Array.isArray(bundle.files) && bundle.files.length > 0
    && bundle.files.every(file => typeof file?.path === 'string' && typeof file.text === 'string');
}
