import { FULL_PERMISSION_SET, LOCKED_PERMISSION_SET, normalizeUiPermissionSet, type PermissionSet } from "@aloneio/runmesh-protocol";

/** Workspace choice vocabulary shared by displayed choices and submitted forms. */
export function workspacePermissionPreset(value: unknown): PermissionSet | undefined {
  if (value === "read_only") return { ...LOCKED_PERMISSION_SET, read: true };
  if (value === "edit_only") return normalizeUiPermissionSet({ ...LOCKED_PERMISSION_SET, edit: true });
  if (value === "controlled_exec" || value === "coding") return { ...FULL_PERMISSION_SET };
  return undefined;
}
