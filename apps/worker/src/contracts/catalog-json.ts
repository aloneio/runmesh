import { CATALOG_LIMITS } from "./catalog.js";
import { canonicalJson } from "./json.js";

/** Apply catalog budgets to the shared canonical serializer. */
export const catalogJson = (value: unknown, maxBytes: number): string | undefined => canonicalJson(value, maxBytes, CATALOG_LIMITS);

export const catalogObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const catalogDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const catalogRevision = (value: unknown, zero = false): value is number =>
  Number.isSafeInteger(value) && (value as number) >= (zero ? 0 : 1) && (value as number) < Number.MAX_SAFE_INTEGER;
export const toolName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(value);
export const catalogKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
