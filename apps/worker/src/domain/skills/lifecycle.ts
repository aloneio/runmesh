import type { SkillBundle } from "../../contracts/skills.js";
import { SKILL_LIFECYCLE_LIMITS, type SkillVersion, type SkillVersionDiff } from "../../contracts/skill-lifecycle.js";

export function cleanupSelection(versions: readonly SkillVersion[], digests: readonly string[]) {
  const selected = versions.filter(version => digests.includes(version.digest));
  if (selected.length !== digests.length) return { state: "conflict" } as const;
  if (selected.some(version => version.active || version.staged || version.pinned)) return { state: "protected" } as const;
  return { state: "selected", bytes: selected.reduce((sum, version) => sum + version.bytes, 0) } as const;
}

/** Compare exactly two retained bodies. Bound displayed UTF-8 text and lines;
 * the file list remains complete and whole files stay available by digest. */
export function compareSkillVersions(before: SkillBundle, after: SkillBundle, revision: number): SkillVersionDiff {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let remainingBytes: number = SKILL_LIFECYCLE_LIMITS.diff_bytes, remainingLines: number = SKILL_LIFECYCLE_LIMITS.diff_lines;
  const excerpt = (text: string) => {
    const maxBytes = Math.min(remainingBytes, SKILL_LIFECYCLE_LIMITS.diff_file_bytes);
    const encoded = encoder.encode(text);
    let end = remainingLines === 0 ? 0 : Math.min(encoded.length, maxBytes);
    // A prefix ends at a UTF-8 codepoint boundary, never a replacement glyph.
    while (end > 0 && end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end--;
    let prefix = decoder.decode(encoded.subarray(0, end)), lines = prefix.length === 0 ? 0 : 1;
    for (let position = prefix.indexOf("\n"); position >= 0; position = prefix.indexOf("\n", position + 1)) {
      if (lines === remainingLines) { prefix = prefix.slice(0, position); break; }
      lines++;
    }
    remainingBytes -= encoder.encode(prefix).byteLength; remainingLines -= lines;
    return { text: prefix, bytes: encoded.length, truncated: prefix.length < text.length };
  };
  const previous = new Map(before.files.map(file => [file.path, file.text])), current = new Map(after.files.map(file => [file.path, file.text]));
  const paths = [...new Set([...previous.keys(), ...current.keys()])].sort(), files: SkillVersionDiff["files"][number][] = [];
  for (const path of paths) {
    const oldText = previous.get(path), newText = current.get(path);
    if (oldText === newText) continue;
    const oldExcerpt = oldText === undefined ? undefined : excerpt(oldText), newExcerpt = newText === undefined ? undefined : excerpt(newText);
    files.push({ path, change: oldText === undefined ? "added" : newText === undefined ? "removed" : "modified",
      before_bytes: oldExcerpt?.bytes ?? 0,
      after_bytes: newExcerpt?.bytes ?? 0,
      ...(oldExcerpt === undefined ? {} : { before_text: oldExcerpt.text }), ...(newExcerpt === undefined ? {} : { after_text: newExcerpt.text }),
      truncated: oldExcerpt?.truncated === true || newExcerpt?.truncated === true });
  }
  const metadata: SkillVersionDiff["metadata"][number][] = [];
  for (const field of ["name", "description", "source", "license", "required_capabilities"] as const) {
    const oldValue = field === "required_capabilities" ? JSON.stringify(before[field] ?? []) : before[field];
    const newValue = field === "required_capabilities" ? JSON.stringify(after[field] ?? []) : after[field];
    if (oldValue !== newValue) metadata.push({ field, before: oldValue, after: newValue });
  }
  return { state: "compared", skill_id: before.skill_id, revision, before: before.digest, after: after.digest, files, metadata,
    truncated: files.some(file => file.truncated) };
}
