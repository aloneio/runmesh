import { SKILL_LIMITS, SKILL_STORED_BUNDLE_BYTES, type SkillHead } from "./skills.js";
import { SKILL_LIFECYCLE_LIMITS, type SkillCapacity, type SkillLifecycleAction } from "./skill-lifecycle.js";
import { skillDigest, skillObject, skillPath } from "./skill-values.js";
import { cleanupDigests, lifecycleRevision } from "./skill-lifecycle-values.js";

/** Validate and project owner receipts independently of HTTP, identity and storage.
 * The adapter owns response status and whether an unconfirmed write is unknown. */
export function projectSkillLifecycleReceipt(raw: unknown, action: SkillLifecycleAction, id: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  try { return projectReceipt(raw, action, id, input); } catch { return undefined; }
}

const safeInteger = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
function headValue(raw: unknown, id: string): SkillHead | undefined {
  const value = skillObject(raw);
  if (!value || value.skill_id !== id || !lifecycleRevision(value.revision) || !skillDigest(value.staged_digest)
    || (value.active_digest !== null && !skillDigest(value.active_digest)) || typeof value.enabled !== "boolean" || (value.enabled && value.active_digest === null)) return undefined;
  return { skill_id: id, revision: value.revision, staged_digest: value.staged_digest, active_digest: value.active_digest, enabled: value.enabled };
}
function capacityValue(raw: unknown): SkillCapacity | undefined {
  const value = skillObject(raw);
  if (!value || !safeInteger(value.skill_bytes, SKILL_LIMITS.storage_bytes) || !safeInteger(value.skill_versions, SKILL_LIMITS.versions)
    || !safeInteger(value.library_bytes, SKILL_LIMITS.storage_bytes) || !safeInteger(value.library_skills, SKILL_LIMITS.skills)
    || value.max_versions !== SKILL_LIMITS.versions || value.max_library_bytes !== SKILL_LIMITS.storage_bytes || value.max_skills !== SKILL_LIMITS.skills
    || value.skill_bytes > value.library_bytes || value.skill_versions === 0 || value.library_skills === 0) return undefined;
  return { skill_bytes: value.skill_bytes, skill_versions: value.skill_versions, library_bytes: value.library_bytes, library_skills: value.library_skills,
    max_versions: value.max_versions, max_library_bytes: value.max_library_bytes, max_skills: value.max_skills };
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function projectReceipt(raw: unknown, action: SkillLifecycleAction, id: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = skillObject(raw); if (!value) return undefined;
  if (action === "versions" && value.state === "listed") {
    const head = headValue(value.head, id), capacity = capacityValue(value.capacity);
    if (!head || !capacity || !Array.isArray(value.versions) || value.versions.length !== capacity.skill_versions) return undefined;
    const seen = new Set<string>();
    const versions = value.versions.map(rawVersion => {
      const version = skillObject(rawVersion), summary = skillObject(version?.summary);
      if (!version || !summary || !skillDigest(version.digest) || seen.has(version.digest) || !safeInteger(version.bytes, SKILL_STORED_BUNDLE_BYTES) || version.bytes < 1
        || !safeInteger(version.file_count, SKILL_LIMITS.files) || version.file_count < 1 || typeof version.pinned !== "boolean"
        || (version.created_at_ms !== null && !safeInteger(version.created_at_ms)) || version.active !== (head.active_digest === version.digest) || version.staged !== (head.staged_digest === version.digest)
        || typeof summary.name !== "string" || summary.name.length > 64 || typeof summary.description !== "string" || summary.description.length > 1024
        || typeof summary.source !== "string" || summary.source.length > 2048 || typeof summary.license !== "string" || summary.license.length > 256) throw new Error("skill_lifecycle_response_invalid");
      seen.add(version.digest);
      return { digest: version.digest, bytes: version.bytes, file_count: version.file_count, created_at_ms: version.created_at_ms,
        pinned: version.pinned, active: version.active, staged: version.staged,
        summary: { name: summary.name, description: summary.description, source: summary.source, license: summary.license } };
    });
    if (!seen.has(head.staged_digest) || (head.active_digest !== null && !seen.has(head.active_digest)) || versions.reduce((sum, version) => sum + version.bytes, 0) !== capacity.skill_bytes) return undefined;
    return { state: "listed", head, versions, capacity };
  }
  if (action === "compare" && value.state === "compared") {
    if (value.skill_id !== id || value.before !== input.before || value.after !== input.after || !lifecycleRevision(value.revision)
      || !Array.isArray(value.files) || value.files.length > SKILL_LIMITS.files * 2 || !Array.isArray(value.metadata) || value.metadata.length > 5 || typeof value.truncated !== "boolean") return undefined;
    const paths = new Set<string>(); let bytes = 0, lines = 0;
    const files = value.files.map(rawFile => {
      const file = skillObject(rawFile);
      if (!file || !skillPath(file.path) || paths.has(file.path) || !["added", "removed", "modified"].includes(String(file.change))
        || !safeInteger(file.before_bytes, SKILL_LIMITS.file_bytes) || !safeInteger(file.after_bytes, SKILL_LIMITS.file_bytes) || typeof file.truncated !== "boolean") throw new Error("skill_lifecycle_response_invalid");
      paths.add(file.path);
      for (const text of [file.before_text, file.after_text]) {
        if (text === undefined) continue;
        if (typeof text !== "string") throw new Error("skill_lifecycle_response_invalid");
        const size = new TextEncoder().encode(text).byteLength;
        if (size > SKILL_LIFECYCLE_LIMITS.diff_file_bytes) throw new Error("skill_lifecycle_response_invalid");
        bytes += size; lines += text.length === 0 ? 0 : text.split("\n").length;
      }
      return { path: file.path, change: file.change, before_bytes: file.before_bytes, after_bytes: file.after_bytes,
        ...(file.before_text === undefined ? {} : { before_text: file.before_text }), ...(file.after_text === undefined ? {} : { after_text: file.after_text }), truncated: file.truncated };
    });
    const fields = new Set<string>();
    const metadata = value.metadata.map(rawField => {
      const field = skillObject(rawField);
      if (!field || !["name", "description", "source", "license", "required_capabilities"].includes(String(field.field)) || fields.has(String(field.field))
        || typeof field.before !== "string" || typeof field.after !== "string" || field.before.length > 8192 || field.after.length > 8192) throw new Error("skill_lifecycle_response_invalid");
      fields.add(String(field.field)); return { field: field.field, before: field.before, after: field.after };
    });
    if (bytes > SKILL_LIFECYCLE_LIMITS.diff_bytes || lines > SKILL_LIFECYCLE_LIMITS.diff_lines || value.truncated !== files.some(file => file.truncated)) return undefined;
    return { state: "compared", skill_id: id, revision: value.revision, before: value.before, after: value.after, files, metadata, truncated: value.truncated };
  }
  if (action === "retention" && value.state === "retained") {
    const head = headValue(value.head, id);
    if (!head || !lifecycleRevision(input.expected_revision) || head.revision !== input.expected_revision + 1 || value.digest !== input.digest || value.pinned !== input.pinned) return undefined;
    return { state: "retained", head, digest: value.digest, pinned: value.pinned };
  }
  if (action === "cleanup-preview" && value.state === "previewed") {
    const plan = skillObject(value.plan), digests = cleanupDigests(plan?.digests), requested = cleanupDigests(input.digests);
    if (!plan || plan.skill_id !== id || !skillDigest(plan.fingerprint) || plan.revision !== input.expected_revision || !digests || !requested
      || !same(plan.digests, digests) || !same(digests, requested) || !safeInteger(plan.bytes, SKILL_LIMITS.storage_bytes) || plan.bytes < 1 || !safeInteger(plan.expires_at_ms)) return undefined;
    return { state: "previewed", plan: { fingerprint: plan.fingerprint, skill_id: id, revision: plan.revision, digests, bytes: plan.bytes, expires_at_ms: plan.expires_at_ms } };
  }
  if (action === "cleanup" && value.state === "cleaned") {
    const head = headValue(value.head, id), capacity = capacityValue(value.capacity), digests = cleanupDigests(value.deleted_digests);
    if (!head || !capacity || !digests || value.skill_id !== id || !lifecycleRevision(input.expected_revision) || head.revision !== input.expected_revision + 1
      || !same(digests, value.deleted_digests) || !safeInteger(value.freed_bytes, SKILL_LIMITS.storage_bytes) || value.freed_bytes < 1
      || digests.includes(head.staged_digest) || (head.active_digest !== null && digests.includes(head.active_digest))) return undefined;
    return { state: "cleaned", skill_id: id, head, deleted_digests: digests, freed_bytes: value.freed_bytes, capacity };
  }
  return undefined;
}
