import type { ActivePolicyReadiness } from "./contracts.js";
import { fail } from "./results/envelope.js";
import { isRecord } from "./results/primitives.js";
import { isSafeIdentifier } from "../security.js";
import type { McpRequestEnv } from "./contracts.js";
import type { PermissionBit } from "./contracts.js";
import type { PermissionCheck } from "./contracts.js";
import { registryCall } from "./transport.js";
import { safeJobIdentifier } from "./results/primitives.js";
import { safeLifecycleId } from "./results/primitives.js";
import type { ToolFailure } from "./contracts.js";

export async function checkPermission(env: McpRequestEnv, clientId: string, runnerId: string, workspaceId: unknown, required: PermissionBit): Promise<PermissionCheck | undefined> {
  if (typeof workspaceId !== "string" || !isSafeIdentifier(workspaceId)) return fail("permission_denied", "Workspace permission could not be resolved.", "Use a workspace identifier managed by the administrator.");
  const call = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/effective-permissions/${encodeURIComponent(runnerId)}?workspace_id=${encodeURIComponent(workspaceId)}`);
  if (!call.ok) return call.error.code === "not_found" ? fail("permission_denied", "The operation is not permitted for this workspace.", "Ask the administrator to grant the required workspace permission.") : call;
  const permissions = isRecord(call.value) && isRecord(call.value.permissions) ? call.value.permissions : undefined;
  if (permissions === undefined || typeof permissions[required] !== "boolean") return fail("authorization_response_invalid", "Workspace authorization returned an invalid response.", "Ask the operator to check the authorization dependency; this does not establish denied permissions.", "not_started");
  if (permissions?.[required] !== true) return fail(required === "edit" ? "readonly_workspace" : "permission_denied", "The operation is not permitted for this workspace.", "Ask the administrator to grant the required workspace permission.");
  return undefined;
}

export async function policyReadiness(env: McpRequestEnv, runnerId: string): Promise<{ readonly ok: true; readonly value: ActivePolicyReadiness } | { readonly ok: false; readonly error: PermissionCheck }> {
  const readiness = await registryCall(env, `/runners/${encodeURIComponent(runnerId)}/policy-readiness`);
  if (!readiness.ok) return { ok: false, error: readiness };
  if (!isRecord(readiness.value)) return { ok: false, error: fail("authorization_response_invalid", "Policy readiness returned an invalid response.", "Ask the operator to check the control plane; no operation was dispatched.", "not_started") };
  const value = readiness.value;
  const desiredRevision = typeof value.desired_revision === "number" && Number.isSafeInteger(value.desired_revision) && value.desired_revision > 0 ? value.desired_revision : undefined;
  const desiredChecksum = typeof value.desired_checksum === "string" && /^[a-f0-9]{64}$/u.test(value.desired_checksum) ? value.desired_checksum : undefined;
  const appliedRevision = typeof value.applied_revision === "number" && Number.isSafeInteger(value.applied_revision) && value.applied_revision > 0 ? value.applied_revision : undefined;
  const activeChecksum = typeof value.active_checksum === "string" && /^[a-f0-9]{64}$/u.test(value.active_checksum) ? value.active_checksum : undefined;
  const reportedRevision = typeof value.runner_reported_policy_revision === "number" && Number.isSafeInteger(value.runner_reported_policy_revision) && value.runner_reported_policy_revision > 0 ? value.runner_reported_policy_revision : undefined;
  const reportedChecksum = typeof value.runner_reported_policy_checksum === "string" && /^[a-f0-9]{64}$/u.test(value.runner_reported_policy_checksum) ? value.runner_reported_policy_checksum : undefined;
  const connectionEpoch = typeof value.connection_epoch === "number" && Number.isSafeInteger(value.connection_epoch) && value.connection_epoch >= 0 ? value.connection_epoch : undefined;
  const credentialVersion = typeof value.credential_version === "number" && Number.isSafeInteger(value.credential_version) && value.credential_version >= 0 ? value.credential_version : undefined;
  const lifecycleId = typeof value.lifecycle_id === "string" && safeLifecycleId(value.lifecycle_id) ? value.lifecycle_id : undefined;
  const sessionId = typeof value.session_id === "string" && safeJobIdentifier(value.session_id) !== undefined ? value.session_id : undefined;
  const triad = desiredRevision !== undefined && appliedRevision !== undefined && reportedRevision !== undefined && desiredChecksum !== undefined && activeChecksum !== undefined && reportedChecksum !== undefined
    && desiredRevision === appliedRevision && reportedRevision === appliedRevision && desiredChecksum === activeChecksum && reportedChecksum === activeChecksum;
  if (value.ok !== true || desiredRevision === undefined || desiredChecksum === undefined || appliedRevision === undefined || activeChecksum === undefined || reportedRevision === undefined || reportedChecksum === undefined || connectionEpoch === undefined || credentialVersion === undefined || lifecycleId === undefined || sessionId === undefined || !triad) {
    const code = value.code === "stale_policy" ? "stale_policy" : "policy_pending";
    return { ok: false, error: fail(code, "The selected runner has no trusted active policy.", "Wait for the runner to reconnect and apply the latest control-plane policy.") };
  }
  return {
    ok: true,
    value: {
      ok: true,
      policy_status: "applied",
      desired_revision: desiredRevision,
      desired_checksum: desiredChecksum,
      applied_revision: appliedRevision,
      active_checksum: activeChecksum,
      runner_reported_policy_revision: reportedRevision,
      runner_reported_policy_checksum: reportedChecksum,
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
  if (!isRecord(snapshot.value) || snapshot.value.ok !== true) return fail("policy_pending", "The selected runner has no trusted active policy snapshot.", "Wait for an active policy to be acknowledged, then retry.");
  return undefined;
}

export async function checkAnyReadPermission(env: McpRequestEnv, clientId: string, runnerId: string): Promise<PermissionCheck | undefined> {
  const snapshotPermission = await snapshotAuthorization(env, runnerId);
  if (snapshotPermission !== undefined) return snapshotPermission;
  const active = await registryCall(env, `/runners/${encodeURIComponent(runnerId)}/active-workspaces`);
  if (!active.ok) return active;
  if (!isRecord(active.value) || !Array.isArray(active.value.workspaces)) return fail("permission_denied", "The operation is not permitted for this runner.", "Ask the administrator to grant read access to a workspace.");
  for (const item of active.value.workspaces) {
    if (!isRecord(item) || typeof item.workspace_id !== "string" || item.enabled !== true) continue;
    const permission = await checkPermission(env, clientId, runnerId, item.workspace_id, "read");
    if (permission === undefined) return undefined;
    if (permission.error.code !== "permission_denied" && permission.error.code !== "readonly_workspace") return permission;
  }
  return fail("permission_denied", "The operation is not permitted for this runner.", "Ask the administrator to grant read access to a workspace.");
}

export function policyPending(): ToolFailure {
  return fail("policy_pending", "The selected runner has not applied the latest policy.", "Wait for the runner to apply its control-plane policy, then retry.") as ToolFailure;
}
