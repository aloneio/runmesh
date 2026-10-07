import { expect, it } from "vitest";
import { cleanupSelection, compareSkillVersions } from "../../apps/worker/src/domain/skills/lifecycle.js";
import { cleanupDigests, lifecycleInput } from "../../apps/worker/src/contracts/skill-lifecycle-values.js";
import { projectSkillLifecycleReceipt } from "../../apps/worker/src/contracts/skill-lifecycle-receipts.js";
import { SKILL_LIFECYCLE_LIMITS, type SkillVersion } from "../../apps/worker/src/contracts/skill-lifecycle.js";
import { SKILL_LIMITS, type SkillBundle } from "../../apps/worker/src/contracts/skills.js";

const bundle = (digest: string, files: SkillBundle["files"]): SkillBundle => ({ schema_version: 1, skill_id: "example", name: "example",
  description: "An example", source: "Local", license: "MIT", digest: digest.repeat(64), files });
const version = (digit: string, patch: Partial<SkillVersion> = {}): SkillVersion => ({ digest: digit.repeat(64), bytes: 100, file_count: 1,
  created_at_ms: null, active: false, staged: false, pinned: false, summary: { name: "example", description: "Example", source: "Local", license: "MIT" }, ...patch });

it("lifecycle receipt projection keeps only public version metadata without an HTTP or storage adapter", () => {
  const digest = "a".repeat(64), head = { skill_id: "example", revision: 3, active_digest: digest, staged_digest: digest, enabled: true };
  const capacity = { skill_bytes: 100, skill_versions: 1, library_bytes: 100, library_skills: 1,
    max_versions: SKILL_LIMITS.versions, max_library_bytes: SKILL_LIMITS.storage_bytes, max_skills: SKILL_LIMITS.skills };
  const clean = { state: "listed", head, capacity, versions: [version("a", { active: true, staged: true })] };
  const raw = { ...clean, internal: "private", head: { ...head, internal: "private" },
    versions: [{ ...clean.versions[0], files: [{ path: "SKILL.md", text: "private body" }] }] };
  expect(projectSkillLifecycleReceipt(raw, "versions", "example", {})).toEqual(clean);
  for (const invalid of [null, {}, { ...raw, versions: [] }, { ...raw, versions: [version("a")] },
    { ...raw, versions: [{ ...raw.versions[0], summary: null }] }, { ...raw, capacity: { ...capacity, skill_bytes: 101 } }])
    expect(projectSkillLifecycleReceipt(invalid, "versions", "example", {})).toBeUndefined();
  expect(projectSkillLifecycleReceipt(raw, "versions", "other", {})).toBeUndefined();
});

it("lifecycle comparison receipts bind the requested versions and preserve bounded domain excerpts", () => {
  const before = bundle("a", [{ path: "SKILL.md", text: "Old" }]);
  const after = bundle("b", [{ path: "SKILL.md", text: "新".repeat(20_000) }]);
  const result = compareSkillVersions(before, after, 3), input = { before: before.digest, after: after.digest };
  expect(projectSkillLifecycleReceipt(result, "compare", "example", input)).toEqual(result);
  expect(projectSkillLifecycleReceipt(result, "compare", "example", { ...input, before: after.digest })).toBeUndefined();
  expect(projectSkillLifecycleReceipt({ ...result, files: [...result.files, ...result.files] }, "compare", "example", input)).toBeUndefined();
  expect(projectSkillLifecycleReceipt({ ...result, files: [{ ...result.files[0], after_text: after.files[0]!.text }] }, "compare", "example", input)).toBeUndefined();
});

it("lifecycle mutation receipts require the next revision and the exact cleanup selection", () => {
  const digest = "a".repeat(64), head = { skill_id: "example", revision: 4, active_digest: digest, staged_digest: digest, enabled: true };
  const retained = { state: "retained", head, digest, pinned: true }, input = { expected_revision: 3, digest, pinned: true };
  expect(projectSkillLifecycleReceipt(retained, "retention", "example", input)).toEqual(retained);
  expect(projectSkillLifecycleReceipt(retained, "retention", "example", { ...input, expected_revision: 4 })).toBeUndefined();
  const preview = { state: "previewed", plan: { fingerprint: "f".repeat(64), skill_id: "example", revision: 4,
    digests: ["b".repeat(64), "c".repeat(64)], bytes: 200, expires_at_ms: 300_000 } };
  const command = { expected_revision: 4, digests: [...preview.plan.digests].reverse() };
  expect(projectSkillLifecycleReceipt(preview, "cleanup-preview", "example", command)).toEqual(preview);
  expect(projectSkillLifecycleReceipt(preview, "cleanup-preview", "example", { ...command, digests: [digest] })).toBeUndefined();
});

it("cleanup requires an exact unique bounded selection and preserves every protection", () => {
  const versions = [version("a"), version("b", { active: true }), version("c", { staged: true }), version("d", { pinned: true })];
  expect(cleanupDigests(["b".repeat(64), "a".repeat(64)])).toEqual(["a".repeat(64), "b".repeat(64)]);
  for (const raw of [[], ["a"], ["a".repeat(64), "a".repeat(64)], Array(33).fill("a".repeat(64))]) expect(cleanupDigests(raw)).toBeUndefined();
  expect(cleanupSelection(versions, ["a".repeat(64)])).toEqual({ state: "selected", bytes: 100 });
  for (const digit of ["b", "c", "d"]) expect(cleanupSelection(versions, ["a".repeat(64), digit.repeat(64)])).toEqual({ state: "protected" });
  expect(cleanupSelection(versions, ["f".repeat(64)])).toEqual({ state: "conflict" });
  expect(lifecycleInput({ digests: [], unexpected: true }, ["digests"])).toBeUndefined();
});

it("diff reports all added, removed and modified paths plus metadata without modifying bundles", () => {
  const before = bundle("a", [{ path: "SKILL.md", text: "unchanged" }, { path: "old.txt", text: "before" }, { path: "shared.txt", text: "old" }]);
  const after = { ...bundle("b", [{ path: "SKILL.md", text: "unchanged" }, { path: "new.txt", text: "新增" }, { path: "shared.txt", text: "new" }]), source: "Updated source" };
  const baseline = JSON.stringify([before, after]), result = compareSkillVersions(before, after, 7);
  expect(result.files).toEqual([
    { path: "new.txt", change: "added", before_bytes: 0, after_bytes: 6, after_text: "新增", truncated: false },
    { path: "old.txt", change: "removed", before_bytes: 6, after_bytes: 0, before_text: "before", truncated: false },
    { path: "shared.txt", change: "modified", before_bytes: 3, after_bytes: 3, before_text: "old", after_text: "new", truncated: false },
  ]);
  expect(result.metadata).toEqual([{ field: "source", before: "Local", after: "Updated source" }]);
  expect(result.truncated).toBe(false); expect(JSON.stringify([before, after])).toBe(baseline);
});

it("diff bounds multibyte excerpts and aggregate output while retaining the complete changed file list", () => {
  const before = bundle("a", []), after = bundle("b", Array.from({ length: 24 }, (_, index) => ({ path: "refs/" + index + ".txt", text: "中🙂".repeat(10_000) })));
  const result = compareSkillVersions(before, after, 1), encoder = new TextEncoder();
  expect(result.files).toHaveLength(24); expect(result.truncated).toBe(true);
  const excerpts = result.files.flatMap(file => [file.before_text ?? "", file.after_text ?? ""]);
  expect(excerpts.reduce((sum, text) => sum + encoder.encode(text).byteLength, 0)).toBeLessThanOrEqual(SKILL_LIFECYCLE_LIMITS.diff_bytes);
  for (const text of excerpts) { expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(SKILL_LIFECYCLE_LIMITS.diff_file_bytes); expect(text).not.toContain("�"); }
  expect(result.files.every(file => file.after_bytes === 70_000 && file.truncated)).toBe(true);
});

it("diff bounds displayed lines across files and both sides", () => {
  const before = bundle("a", [{ path: "same.txt", text: "a\n".repeat(1500) }]);
  const after = bundle("b", [{ path: "same.txt", text: "b\n".repeat(1500) }, { path: "other.txt", text: "c\n".repeat(1500) }]);
  const result = compareSkillVersions(before, after, 1);
  const lines = result.files.flatMap(file => [file.before_text ?? "", file.after_text ?? ""]).reduce((sum, text) => sum + (text.length ? text.split("\n").length : 0), 0);
  expect(lines).toBeLessThanOrEqual(SKILL_LIFECYCLE_LIMITS.diff_lines); expect(result.truncated).toBe(true);
});
