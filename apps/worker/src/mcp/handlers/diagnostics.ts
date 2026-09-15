import { asToolResult } from "../results/envelope.js";
import { callRunner } from "../transport.js";
import { capabilityDiagnostics } from "../capability-diagnostics.js";
import { isRecord } from "../results/primitives.js";
import type { McpRequestEnv } from "../contracts.js";
import { policyReadiness } from "../authorization.js";
import { registryCall } from "../transport.js";
import { resolveActiveRunner } from "../selection.js";
import { runnerSuccess } from "../results/envelope.js";
import { safePositiveIntegerValue } from "../results/primitives.js";

export async function diagnosticsTool(env: McpRequestEnv, clientId: string, workspaceId: string, scopes: readonly string[]): Promise<unknown> {
  const observedAtMs = Date.now();
  const selected = await resolveActiveRunner(env, clientId, true);
  if (!selected.ok) return asToolResult(selected);
  const checks: Array<Record<string, unknown>> = [
    { name: "worker_auth", state: "pass", evidence_source: "mcp_revalidation", observed_at_ms: observedAtMs },
    { name: "runner_selection", state: selected.value.context.state === "online" ? "pass" : "fail", code: selected.value.context.state === "online" ? null : "runner_offline", evidence_source: "registry", observed_at_ms: observedAtMs },
  ];
  const permissionCall = await registryCall(env, `/auth/clients/${encodeURIComponent(clientId)}/effective-permissions/${encodeURIComponent(selected.value.runnerId)}?workspace_id=${encodeURIComponent(workspaceId)}`);
  const permissionValue = permissionCall.ok && isRecord(permissionCall.value) && isRecord(permissionCall.value.permissions) ? permissionCall.value.permissions : undefined;
  const permissions = permissionValue === undefined ? undefined : {
    read: permissionValue.read === true,
    edit: permissionValue.edit === true,
    shell: permissionValue.shell === true,
    job_control: permissionValue.job_control === true,
  };
  checks.push({ name: "workspace_authorization", state: permissions === undefined ? "unknown" : permissions.read ? "pass" : "fail", code: permissions === undefined ? "permission_state_unavailable" : permissions.read ? null : "permission_denied", evidence_source: "effective_permission", observed_at_ms: observedAtMs });

  const readinessRaw = await registryCall(env, `/runners/${encodeURIComponent(selected.value.runnerId)}/policy-readiness`);
  const readinessValue = readinessRaw.ok && isRecord(readinessRaw.value) ? readinessRaw.value : undefined;
  const policyState = readinessValue?.ok === true ? "pass" : readinessValue === undefined ? "unknown" : "fail";
  checks.push({
    name: "policy_alignment",
    state: policyState,
    code: policyState === "pass" ? null : typeof readinessValue?.code === "string" ? readinessValue.code : "policy_state_unavailable",
    evidence_source: "registry_policy_readiness",
    observed_at_ms: observedAtMs,
    desired_revision: safePositiveIntegerValue(readinessValue?.desired_revision),
    applied_revision: safePositiveIntegerValue(readinessValue?.applied_revision),
    runner_reported_revision: safePositiveIntegerValue(readinessValue?.runner_reported_policy_revision),
  });

  let rpcState: "pass" | "fail" | "unknown" = "unknown";
  let rpcCode: string | null = null;
  let shell: Record<string, unknown> | undefined;
  let runtimeCapabilities: unknown;
  if (selected.value.context.state !== "online") rpcCode = "runner_offline";
  else if (permissions?.read !== true) rpcCode = permissions === undefined ? "permission_state_unavailable" : "permission_denied";
  else {
    const readiness = await policyReadiness(env, selected.value.runnerId);
    if (!readiness.ok) rpcCode = readiness.error.error.code;
    else {
      const live = await callRunner(env, selected.value.runnerId, "env.info", { workspace_id: workspaceId }, readiness.value.applied_revision, readiness.value.active_checksum);
      rpcState = live.ok ? "pass" : "fail";
      if (live.ok && isRecord(live.value)) runtimeCapabilities = live.value.runtime_capabilities;
      rpcCode = live.ok ? null : live.error.code;
      if (live.ok && isRecord(live.value) && isRecord(live.value.shell)) {
        shell = { available: live.value.shell.available === true };
        if (live.value.shell.available === true && (live.value.shell.kind === "bash" || live.value.shell.kind === "powershell")) shell.kind = live.value.shell.kind;
      }
    }
  }
  checks.push({ name: "runner_rpc", state: rpcState, code: rpcCode, evidence_source: "live_rpc", observed_at_ms: Date.now() });
  const value: Record<string, unknown> = { workspace_id: workspaceId, observed_at_ms: observedAtMs, permissions: permissions ?? null, checks, capabilities: capabilityDiagnostics(runtimeCapabilities, scopes, permissions) };
  if (shell !== undefined) value.shell = shell;
  return runnerSuccess(value, selected.value);
}
