import type { PermissionSet } from "./schema.js";

export const PERMISSION_BITS = ["read", "edit", "shell", "job_control"] as const;
export type PermissionBit = (typeof PERMISSION_BITS)[number];

export const LOCKED_PERMISSION_SET: PermissionSet = Object.freeze({ read: false, edit: false, shell: false, job_control: false });
export const FULL_PERMISSION_SET: PermissionSet = Object.freeze({ read: true, edit: true, shell: true, job_control: true });

/**
 * Parses a complete permission set without attempting to repair it. API and
 * persisted policy input must be canonical already; silently granting implied
 * permissions would turn malformed input into a privilege escalation.
 */
export function validatePermissionSet(value: unknown): PermissionSet | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== PERMISSION_BITS.length || !PERMISSION_BITS.every((bit) => typeof record[bit] === "boolean")) return undefined;
  const permissions: PermissionSet = {
    read: record.read as boolean,
    edit: record.edit as boolean,
    shell: record.shell as boolean,
    job_control: record.job_control as boolean,
  };
  return isCanonicalPermissionSet(permissions) ? permissions : undefined;
}

export function isCanonicalPermissionSet(value: unknown): value is PermissionSet {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!PERMISSION_BITS.every((bit) => typeof record[bit] === "boolean")) return false;
  return (!record.edit || record.read === true)
    && (!record.job_control || record.read === true)
    && (!record.shell || (record.read === true && record.edit === true && record.job_control === true));
}

/** UI-only normalization may add explicit dependencies while displaying them. */
export function normalizeUiPermissionSet(value: PermissionSet): PermissionSet {
  const normalized = { ...value };
  if (normalized.shell) {
    normalized.read = true;
    normalized.edit = true;
    normalized.job_control = true;
  }
  if (normalized.edit || normalized.job_control) normalized.read = true;
  return normalized;
}

/**
 * Canonicalizes an intersection only by taking permissions away. This keeps a
 * restrictive boundary restrictive even if an upstream set is contradictory.
 */
export function restrictPermissionSet(value: Pick<PermissionSet, PermissionBit>): PermissionSet {
  const restricted: PermissionSet = { ...value };
  if (!restricted.read) {
    restricted.edit = false;
    restricted.shell = false;
    restricted.job_control = false;
  }
  if (!restricted.edit) restricted.shell = false;
  if (!restricted.job_control) restricted.shell = false;
  return restricted;
}

export function intersectPermissionSets(...sets: readonly PermissionSet[]): PermissionSet {
  if (sets.length === 0) return { ...LOCKED_PERMISSION_SET };
  return restrictPermissionSet({
    read: sets.every((set) => set.read),
    edit: sets.every((set) => set.edit),
    shell: sets.every((set) => set.shell),
    job_control: sets.every((set) => set.job_control),
  });
}

/** Permission ceiling used only in effective-policy evaluation; public tools still check their own MCP scope. */
export function permissionSetFromScopes(scopes: readonly string[]): PermissionSet {
  return scopes.includes("coding:exec")
    ? { ...FULL_PERMISSION_SET }
    : scopes.includes("coding:write")
      ? { read: true, edit: true, shell: false, job_control: false }
      : scopes.includes("coding:read")
        ? { read: true, edit: false, shell: false, job_control: false }
        : { ...LOCKED_PERMISSION_SET };
}
