import { SKILL_LIMITS } from "./skills.js";
import { skillDigest, skillObject } from "./skill-values.js";

/** Shared wire values for lifecycle commands and receipts. */
export function lifecycleRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < Number.MAX_SAFE_INTEGER;
}
export function lifecycleInput(input: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  const value = skillObject(input);
  return value && Object.keys(value).every(key => keys.includes(key)) ? value : undefined;
}
export function cleanupDigests(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > SKILL_LIMITS.versions || !value.every(skillDigest)) return undefined;
  const digests = [...value].sort();
  return new Set(digests).size === digests.length ? digests : undefined;
}
