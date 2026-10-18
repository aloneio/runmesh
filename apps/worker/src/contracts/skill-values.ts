import { isCapabilityIdentifier } from "./capabilities.js";

export const skillDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export function skillObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function skillPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 200 || !/^[A-Za-z0-9._/-]+$/u.test(value)) return false;
  const parts = value.split("/");
  return parts.every(p => p !== "" && p !== "." && p !== ".." && !p.endsWith(".")
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:[.]|$)/iu.test(p));
}

export type SkillCommand =
  | { readonly action: "preview"; readonly bundle: unknown }
  | { readonly action: "stage"; readonly bundle: unknown; readonly expected_revision: number }
  | { readonly action: "activate"; readonly skill_id: string; readonly digest: string; readonly expected_revision: number }
  | { readonly action: "disable"; readonly skill_id: string; readonly expected_revision: number }
  | { readonly action: "rename"; readonly skill_id: string; readonly display_name: string; readonly expected_revision: number }
  | { readonly action: "delete"; readonly skill_id: string; readonly expected_revision: number; readonly confirm: true };

/** Select an exact operation before authorization or storage. Bundle content is
 * validated by the domain once the administrator has been admitted. */
export function parseSkillCommand(input: unknown): SkillCommand | undefined {
  const value = skillObject(input);
  if (!value || !isCapabilityIdentifier(value.skill_id)) return undefined;
  if (value.action === "preview") return { action: "preview", bundle: value };
  const revision = value.expected_revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) return undefined;
  switch (value.action) {
    case "stage": return { action: "stage", bundle: value, expected_revision: revision };
    case "activate": return skillDigest(value.digest)
      ? { action: "activate", skill_id: value.skill_id, digest: value.digest, expected_revision: revision } : undefined;
    case "disable": return { action: "disable", skill_id: value.skill_id, expected_revision: revision };
    case "rename": return typeof value.display_name === "string" && value.display_name.trim().length > 0 && value.display_name.length <= 64
      && !/[\u0000-\u001f\u007f]/u.test(value.display_name) && Object.keys(value).length === 4
      ? { action: "rename", skill_id: value.skill_id, display_name: value.display_name, expected_revision: revision } : undefined;
    case "delete": return value.confirm === true && Object.keys(value).length === 4
      ? { action: "delete", skill_id: value.skill_id, expected_revision: revision, confirm: true } : undefined;
    default: return undefined;
  }
}
