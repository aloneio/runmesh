import type { RunnerWelcome, RunnerMetadata } from "@aloneio/runmesh-protocol";
import type { WorkspaceConfig } from "../config.js";
import { effectiveCentralPermissions, validateCentralWorkspacePolicy, type CentralWorkspacePolicy } from "../policy-config.js";

export function effectivePolicyWorkspaces(policy: NonNullable<RunnerWelcome["desired_policy"]>, workspaces: readonly WorkspaceConfig[]): WorkspaceConfig[] {
  return workspaces.map((workspace) => {
    const source = policy.workspaces.find((item) => item.workspace_id === workspace.workspaceId);
    if (source === undefined) throw new Error("policy validation lost a workspace");
    const permissions = effectiveCentralPermissions(policy.runner_permissions, source.permissions);
    return { ...workspace, permissions, readonly: !permissions.edit, shell: permissions.shell };
  });
}

export async function candidateWorkspaces(policy: NonNullable<RunnerWelcome["desired_policy"]>, executionMode?: "dedicated_user" | "privileged_host", serviceIdentity?: string): Promise<WorkspaceConfig[]> {
  const validation = await validateCentralWorkspacePolicy(policy.workspaces as CentralWorkspacePolicy[], {
    ...(executionMode === undefined ? {} : { executionMode }),
    ...(serviceIdentity === undefined ? {} : { serviceIdentity }),
  });
  if (validation.status.some((item) => item.status !== "valid")) throw new Error("persisted active policy is not locally valid");
  return effectivePolicyWorkspaces(policy, validation.workspaces);
}
export function validationContext(metadata: RunnerMetadata): { readonly executionMode?: "dedicated_user" | "privileged_host"; readonly serviceIdentity?: string } {
  return {
    ...(metadata.execution_mode === undefined ? {} : { executionMode: metadata.execution_mode }),
    ...(metadata.service_identity === undefined ? {} : { serviceIdentity: metadata.service_identity }),
  };
}
