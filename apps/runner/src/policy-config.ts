import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
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
  for (const workspace of workspaces) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workspace.workspace_id) || seen.has(workspace.workspace_id) || !workspace.root_path || workspace.root_path.includes("\0") || !isAbsolute(workspace.root_path) || !validCentralPermissionSet(workspace.permissions)) { status.push({ workspace_id: workspace.workspace_id, status: "invalid_path" }); continue; }
    seen.add(workspace.workspace_id);
    if (!workspace.enabled) { status.push({ workspace_id: workspace.workspace_id, status: "valid" }); continue; }
    let canonical: string;
    try { canonical = await realpath(workspace.root_path); } catch (error) { status.push({ workspace_id: workspace.workspace_id, status: errno(error, "EACCES") || errno(error, "EPERM") ? "permission_denied" : "missing" }); continue; }
    try {
      const info = await lstat(canonical);
      if (!info.isDirectory()) { status.push({ workspace_id: workspace.workspace_id, status: "not_directory" }); continue; }
    } catch (error) { status.push({ workspace_id: workspace.workspace_id, status: errno(error, "EACCES") || errno(error, "EPERM") ? "permission_denied" : "missing" }); continue; }
    accepted.push({ workspaceId: workspace.workspace_id, rootPath: canonical, readonly: !workspace.permissions.edit, shell: workspace.permissions.shell, permissions: workspace.permissions });
    status.push({ workspace_id: workspace.workspace_id, status: "valid" });
  }
  return { workspaces: accepted, status };
}
function errno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }
