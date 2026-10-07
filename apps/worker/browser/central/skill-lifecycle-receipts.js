const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const digests = values => Array.isArray(values) && values.every(digest) && new Set(values).size === values.length;
const sameSet = (left, right) => digests(left) && digests(right) && left.length === right.length && left.every(value => right.includes(value));
const headFor = (head, id) => head?.skill_id === id && count(head.revision) && head.revision > 0
  && digest(head.staged_digest) && (head.active_digest === null || digest(head.active_digest)) && typeof head.enabled === 'boolean';
const capacityValid = value => value && ['skill_bytes', 'skill_versions', 'library_bytes', 'library_skills', 'max_versions', 'max_library_bytes', 'max_skills'].every(key => count(value[key]));

/** Lifecycle receipts are checked at the browser boundary, before creating controls. */
export function validSkillLifecycleReceipt(request, body, value) {
  const { id, operation } = request;
  if (operation === 'versions') return headFor(value.head, id) && capacityValid(value.capacity)
    && Array.isArray(value.versions) && value.versions.length <= value.capacity.max_versions
    && digests(value.versions.map(version => version?.digest))
    && value.versions.every(version => count(version.bytes) && count(version.file_count)
      && (version.created_at_ms === null || count(version.created_at_ms) && version.created_at_ms <= 8640000000000000)
      && ['pinned', 'active', 'staged'].every(key => typeof version[key] === 'boolean')
      && ['name', 'description', 'source', 'license'].every(key => typeof version.summary?.[key] === 'string'));
  if (operation === 'retention') return headFor(value.head, id) && value.head.revision === body.expected_revision + 1
    && value.digest === body.digest && value.pinned === body.pinned;
  if (operation === 'cleanup-preview') return value.plan?.skill_id === id && value.plan.revision === body.expected_revision
    && digest(value.plan.fingerprint)
    && count(value.plan.bytes) && count(value.plan.expires_at_ms) && sameSet(value.plan.digests, body.digests);
  if (operation === 'cleanup') return value.skill_id === id && headFor(value.head, id) && value.head.revision === body.expected_revision + 1
    && digests(value.deleted_digests) && value.deleted_digests.length > 0 && count(value.freed_bytes) && capacityValid(value.capacity);
  if (operation === 'compare') return value.skill_id === id && count(value.revision) && value.revision > 0
    && value.before === body.before && value.after === body.after && typeof value.truncated === 'boolean'
    && Array.isArray(value.files) && value.files.every(file => typeof file?.path === 'string'
      && ['added', 'removed', 'modified'].includes(file.change) && count(file.before_bytes) && count(file.after_bytes)
      && (file.before_text === undefined || typeof file.before_text === 'string')
      && (file.after_text === undefined || typeof file.after_text === 'string') && typeof file.truncated === 'boolean')
    && Array.isArray(value.metadata) && value.metadata.every(field => ['name', 'description', 'source', 'license', 'required_capabilities'].includes(field?.field)
      && typeof field.before === 'string' && typeof field.after === 'string');
  return false;
}
