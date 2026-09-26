import { parseSkillBundle, skillObject } from "./bundle.js";

/** Uploaded frontmatter describes content; it never grants capabilities. */
export function skillInstallation(input: unknown) {
  const value = skillObject(input);
  if (!value || Object.keys(value).some(key => !["files", "expected_revision"].includes(key))) return undefined;
  const revision = value.expected_revision ?? 0;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 || (revision as number) >= Number.MAX_SAFE_INTEGER) return undefined;
  const bundle = parseSkillBundle({ skill_id: "upload", files: value.files, source: "Control panel upload", license: "" });
  return bundle ? { bundle: { ...bundle, skill_id: bundle.name }, revision: revision as number } : undefined;
}
