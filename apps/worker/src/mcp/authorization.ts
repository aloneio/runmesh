import type { ActivePolicyReadiness } from "./contracts.js";
import { appliedPolicyIdentity } from "../contracts/runner-selection.js";
import { fail } from "./results/envelope.js";
import { isRecord, isSafePositiveInteger, isSha256 } from "./results/primitives.js";
import { isSafeIdentifier } from "../security.js";
import type { McpRequestEnv } from "./contracts.js";
import type { PermissionBit } from "./contracts.js";
import type { PermissionCheck } from "./contracts.js";
import { registryCall } from "./transport.js";
import { safeJobIdentifier } from "./results/primitives.js";
import { safeLifecycleId } from "./results/primitives.js";
import { safeWorkspaceMetadata } from "./results/selection.js";
import type { ToolFailure } from "./contracts.js";

export async function checkPermission(env: McpRequestEnv, clientId: string, runnerId: string, workspaceId: unknown, required: PermissionBit): Promise<PermissionCheck | undefined> {
  if (typeof workspaceId !== "string" || !isSafeIdentifier(workspaceId)) return fail("permission_denied", "Workspace permission could not be resolved.", "Use a workspace identifier managed by the administrator.");
  const call = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/effective-permissions/${encodeURIComponent(runnerId)}?workspace_id=${encodeURIComponent(workspaceId)}`);
  if (!call.ok) return call.error.code === "not_found" ? fail("permission_denied", "The operation is not permitted for this workspace.", "Ask the administrator to grant the required workspace permission.") : call;
  const permissions = isRecord(call.value) && isRecord(call.value.permissions) ? call.value.permissions : undefined;
  if (permissions === undefined || typeof permissions[required] !== "boolean") return fail("authorization_response_invalid", "Workspace authorization returned an invalid response.", "Ask the administrator to check the control-plane logs.", "not_started");
  if (permissions?.[required] !== true) return fail(required === "edit" ? "readonly_workspace" : "permission_denied", "The operation is not permitted for this workspace.", "Ask the administrator to grant the required workspace permission.");
  return undefined;
}

export async function policyReadiness(env: McpRequestEnv, runnerId: string): Promise<{ readonly ok: true; readonly value: ActivePolicyReadiness } | { readonly ok: false; readonly error: PermissionCheck }> {
  const readiness = await registryCall(env, `/runners/${encodeURIComponent(runnerId)}/policy-readiness`);
  if (!readiness.ok) return { ok: false, error: readiness };
  if (!isRecord(readiness.value)) return { ok: false, error: fail("authorization_response_invalid", "Policy readiness returned an invalid response.", "Ask the operator to check the control plane; no operation was dispatched.", "not_started") };
  const value = readiness.value;
  const policy = appliedPolicyIdentity(value);
  const connectionEpoch = typeof value.connection_epoch === "number" && Number.isSafeInteger(value.connection_epoch) && value.connection_epoch >= 0 ? value.connection_epoch : undefined;
  const credentialVersion = typeof value.credential_version === "number" && Number.isSafeInteger(value.credential_version) && value.credential_version >= 0 ? value.credential_version : undefined;
  const lifecycleId = typeof value.lifecycle_id === "string" && safeLifecycleId(value.lifecycle_id) ? value.lifecycle_id : undefined;
  const sessionId = typeof value.session_id === "string" && safeJobIdentifier(value.session_id) !== undefined ? value.session_id : undefined;
  if (policy === undefined || connectionEpoch === undefined || credentialVersion === undefined || lifecycleId === undefined || sessionId === undefined) {
    const code = value.code === "stale_policy" ? "stale_policy" : "policy_pending";
    return { ok: false, error: fail(code, "The selected runner has no trusted active policy.", "Wait for the runner to reconnect and apply the latest control-plane policy.") };
  }
  return {
    ok: true,
    value: {
      ok: true,
      policy_status: "applied",
      desired_revision: policy.applied_revision,
      desired_checksum: policy.active_checksum,
      applied_revision: policy.applied_revision,
      active_checksum: policy.active_checksum,
      runner_reported_policy_revision: policy.applied_revision,
      runner_reported_policy_checksum: policy.active_checksum,
      connection_epoch: connectionEpoch,
      credential_version: credentialVersion,
      lifecycle_id: lifecycleId,
      session_id: sessionId,
    },
  };
}

async function snapshotAuthorization(env: McpRequestEnv, runnerId: string): Promise<ToolFailure | undefined> {
  const snapshot = await registryCall(env, `/runners/${encodeURIComponent(runnerId)}/snapshot-authorization`);
  if (!snapshot.ok) return snapshot;
  if (!isRecord(snapshot.value) || typeof snapshot.value.ok !== "boolean"
    || (snapshot.value.ok ? !isSafePositiveInteger(snapshot.value.revision) || !isSha256(snapshot.value.checksum)
      : (snapshot.value.code !== "policy_pending" && snapshot.value.code !== "stale_policy") || typeof snapshot.value.reason !== "string")) {
    return fail("authorization_response_invalid", "Policy snapshot authorization returned an invalid response.", "Ask the administrator to check the control-plane logs.", "not_started");
  }
  if (!snapshot.value.ok) return fail("policy_pending", "The selected runner has no trusted active policy snapshot.", "Wait for an active policy to be acknowledged, then retry.");
  return undefined;
}

export async function checkAnyReadPermission(env: McpRequestEnv, clientId: string, runnerId: string): Promise<PermissionCheck | undefined> {
  const snapshotPermission = await snapshotAuthorization(env, runnerId);
  if (snapshotPermission !== undefined) return snapshotPermission;
  // The Registry computes the current client/policy intersection once for the
  // complete list, without one additional request per enabled workspace.
  const effective = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/effective-workspaces/${encodeURIComponent(runnerId)}`);
  if (!effective.ok) return effective.error.code === "not_found"
    ? fail("permission_denied", "The operation is not permitted for this runner.", "Ask the administrator to grant read access to a workspace.") : effective;
  const value = effective.value;
  if (!isRecord(value) || value.runner_id !== runnerId || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(value.checksum)
    || !Array.isArray(value.workspaces) || value.workspaces.some(workspace => safeWorkspaceMetadata(workspace) === undefined)) {
    return fail("authorization_response_invalid", "Runner workspace authorization returned an invalid response.", "Ask the administrator to check the control-plane logs.", "not_started");
  }
  if (value.workspaces.some(workspace => isRecord(workspace) && workspace.enabled === true && isRecord(workspace.permissions) && workspace.permissions.read === true)) return undefined;
  return fail("permission_denied", "The operation is not permitted for this runner.", "Ask the administrator to grant read access to a workspace.");
}

export function policyPending(): ToolFailure {
  return fail("policy_pending", "The selected runner has not applied the latest policy.", "Wait for the runner to apply its control-plane policy, then retry.") as ToolFailure;
}
