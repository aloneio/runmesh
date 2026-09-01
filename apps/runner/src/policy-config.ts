import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { PermissionSet, WorkspaceConfig } from "./config.js";

export type WorkspaceValidationStatus = "valid" | "missing" | "not_directory" | "permission_denied" | "invalid_path";
export type CentralWorkspacePolicy = { readonly workspace_id: string; readonly root_path: string; readonly enabled: boolean; readonly permissions: PermissionSet };
export type WorkspaceValidationStage = "realpath" | "lstat";
export type WorkspaceValidationReason = "os_access_denied";
export type WorkspaceValidationRemediation = "migrate_privileged_host" | "grant_os_access" | "confirm_privileged_host" | "check_workspace_acl" | "run_as_admin";
export type WorkspaceValidationDiagnostic = {
  readonly workspace_id: string;
  readonly status: WorkspaceValidationStatus;
  readonly validation_stage?: WorkspaceValidationStage;
  readonly reason?: WorkspaceValidationReason;
  readonly service_identity?: string;
  readonly execution_mode?: "dedicated_user" | "privileged_host";
  readonly remediation_code?: WorkspaceValidationRemediation;
};

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

export interface WorkspaceValidationContext {
  readonly serviceIdentity?: string;
  readonly executionMode?: "dedicated_user" | "privileged_host";
  /** Injectable filesystem seams keep OS-denial diagnostics testable. */
  readonly realpath?: typeof realpath;
  readonly lstat?: typeof lstat;
}

export async function validateCentralWorkspacePolicy(workspaces: readonly CentralWorkspacePolicy[], context: WorkspaceValidationContext = {}): Promise<{ workspaces: WorkspaceConfig[]; status: WorkspaceValidationDiagnostic[] }> {
  const accepted: WorkspaceConfig[] = [];
  const status: WorkspaceValidationDiagnostic[] = [];
  const seen = new Set<string>();
  const canonical: Array<{ readonly workspace: CentralWorkspacePolicy; readonly path: string }> = [];
  for (const workspace of workspaces) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workspace.workspace_id) || seen.has(workspace.workspace_id) || !workspace.root_path || workspace.root_path.includes("\0") || !isAbsolute(workspace.root_path) || !validCentralPermissionSet(workspace.permissions)) { status.push(diagnostic(workspace.workspace_id, "invalid_path", context)); continue; }
    seen.add(workspace.workspace_id);
    if (!workspace.enabled) { status.push(diagnostic(workspace.workspace_id, "valid", context)); continue; }
    let path: string;
    try { path = await (context.realpath ?? realpath)(workspace.root_path); } catch (error) {
      const denied = errno(error, "EACCES") || errno(error, "EPERM");
      status.push(denied ? accessDiagnostic(workspace.workspace_id, "permission_denied", "realpath", context) : diagnostic(workspace.workspace_id, "missing"));
      continue;
    }
    try {
      const info = await (context.lstat ?? lstat)(path);
      if (!info.isDirectory()) { status.push(diagnostic(workspace.workspace_id, "not_directory")); continue; }
    } catch (error) {
      const denied = errno(error, "EACCES") || errno(error, "EPERM");
      status.push(denied ? accessDiagnostic(workspace.workspace_id, "permission_denied", "lstat", context) : diagnostic(workspace.workspace_id, "missing"));
      continue;
    }
    canonical.push({ workspace, path });
  }
  const overlapping = canonical.filter((entry, index) => canonical.some((other, otherIndex) => index !== otherIndex && (nestedRoot(entry.path, other.path) || nestedRoot(other.path, entry.path))));
  const overlappingIds = new Set(overlapping.map((entry) => entry.workspace.workspace_id));
  for (const entry of canonical) {
    if (overlappingIds.has(entry.workspace.workspace_id)) { status.push(diagnostic(entry.workspace.workspace_id, "invalid_path", context)); continue; }
    accepted.push({ workspaceId: entry.workspace.workspace_id, rootPath: entry.path, readonly: !entry.workspace.permissions.edit, shell: entry.workspace.permissions.shell, permissions: entry.workspace.permissions });
    status.push(diagnostic(entry.workspace.workspace_id, "valid", context));
  }
  return { workspaces: accepted, status };
}
function nestedRoot(left: string, right: string): boolean {
  const relation = relative(left, right);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}
function errno(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code; }
function diagnostic(workspaceId: string, status: WorkspaceValidationStatus, _context?: WorkspaceValidationContext): WorkspaceValidationDiagnostic {
  return { workspace_id: workspaceId, status };
}
function accessDiagnostic(workspaceId: string, status: Exclude<WorkspaceValidationStatus, "valid">, stage: WorkspaceValidationStage, context: WorkspaceValidationContext = {}): WorkspaceValidationDiagnostic {
  const identity = safeDiagnosticIdentity(context.serviceIdentity);
  return {
    workspace_id: workspaceId,
    status,
    validation_stage: stage,
    reason: "os_access_denied",
    ...(identity === undefined ? {} : { service_identity: identity }),
    ...(context.executionMode === undefined ? {} : { execution_mode: context.executionMode }),
    remediation_code: context.executionMode === "privileged_host" ? "grant_os_access" : "migrate_privileged_host",
  };
}

/** Keep administrator diagnostics bounded and free of control characters. */
function safeDiagnosticIdentity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed) ? trimmed : undefined;
}
