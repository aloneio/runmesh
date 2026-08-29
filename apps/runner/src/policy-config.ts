import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { PermissionSet, WorkspaceConfig } from "./config.js";

export type WorkspaceValidationStatus = "valid" | "missing" | "not_directory" | "permission_denied" | "invalid_path";
export type CentralWorkspacePolicy = { readonly workspace_id: string; readonly root_path: string; readonly enabled: boolean; readonly permissions: PermissionSet };

export function validCentralPermissionSet(value: PermissionSet): boolean {
  return value.read || (!value.edit && !value.shell && !value.job_control);
}

export function effectiveCentralPermissions(runner: PermissionSet, workspace: PermissionSet): PermissionSet {
  return {
    read: runner.read && workspace.read,
    edit: runner.edit && workspace.edit,
    shell: runner.shell && workspace.shell,
    job_control: runner.job_control && workspace.job_control,
  };
}

export async function validateCentralWorkspacePolicy(workspaces: readonly CentralWorkspacePolicy[]): Promise<{ workspaces: WorkspaceConfig[]; status: Array<{ workspace_id: string; status: WorkspaceValidationStatus }> }> {
  const accepted: WorkspaceConfig[] = [];
  const status: Array<{ workspace_id: string; status: WorkspaceValidationStatus }> = [];
  const seen = new Set<string>();
  const canonical: Array<{ readonly workspace: CentralWorkspacePolicy; readonly path: string }> = [];
  for (const workspace of workspaces) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workspace.workspace_id) || seen.has(workspace.workspace_id) || !workspace.root_path || workspace.root_path.includes("\0") || !isAbsolute(workspace.root_path) || !validCentralPermissionSet(workspace.permissions)) { status.push({ workspace_id: workspace.workspace_id, status: "invalid_path" }); continue; }
    seen.add(workspace.workspace_id);
    if (!workspace.enabled) { status.push({ workspace_id: workspace.workspace_id, status: "valid" }); continue; }
    let path: string;
    try { path = await realpath(workspace.root_path); } catch (error) { status.push({ workspace_id: workspace.workspace_id, status: errno(error, "EACCES") || errno(error, "EPERM") ? "permission_denied" : "missing" }); continue; }
    try {
      const info = await lstat(path);
      if (!info.isDirectory()) { status.push({ workspace_id: workspace.workspace_id, status: "not_directory" }); continue; }
    } catch (error) { status.push({ workspace_id: workspace.workspace_id, status: errno(error, "EACCES") || errno(error, "EPERM") ? "permission_denied" : "missing" }); continue; }
    canonical.push({ workspace, path });
  }
  const overlapping = canonical.filter((entry, index) => canonical.some((other, otherIndex) => index !== otherIndex && (nestedRoot(entry.path, other.path) || nestedRoot(other.path, entry.path))));
  const overlappingIds = new Set(overlapping.map((entry) => entry.workspace.workspace_id));
  for (const entry of canonical) {
    if (overlappingIds.has(entry.workspace.workspace_id)) { status.push({ workspace_id: entry.workspace.workspace_id, status: "invalid_path" }); continue; }
    accepted.push({ workspaceId: entry.workspace.workspace_id, rootPath: entry.path, readonly: !entry.workspace.permissions.edit, shell: entry.workspace.permissions.shell, permissions: entry.workspace.permissions });
    status.push({ workspace_id: entry.workspace.workspace_id, status: "valid" });
  }
  return { workspaces: accepted, status };
}
function nestedRoot(left: string, right: string): boolean {
  const relation = relative(left, right);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}
function errno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }
