import { asToolResult } from "./results/envelope.js";
import { callRunner } from "./transport.js";
import { checkAnyReadPermission } from "./authorization.js";
import { checkPermission } from "./authorization.js";
import type { McpRequestEnv } from "./contracts.js";
import type { PermissionBit } from "./contracts.js";
import { policyReadiness } from "./authorization.js";
import { projectRunnerResult } from "./results/project.js";
import { recordRunnerToolCall } from "./audit.js";
import { resolveActiveRunner } from "./selection.js";
import { runnerFailure } from "./results/envelope.js";
import type { RunnerResultMode } from "./contracts.js";
import { runnerSuccess } from "./results/envelope.js";
import { withAuditReceipt } from "./audit.js";

export async function activeRunnerTool(env: McpRequestEnv, clientId: string, method: string, params: Record<string, unknown>, requiredPermission?: PermissionBit, resultMode: RunnerResultMode = "raw"): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId);
  if (!selected.ok) return asToolResult(selected);
  const permission = requiredPermission === undefined
    ? undefined
    : params.workspace_id === undefined
      ? await checkAnyReadPermission(env, clientId, selected.value.runnerId)
      : await checkPermission(env, clientId, selected.value.runnerId, params.workspace_id, requiredPermission);
  if (permission !== undefined) return asToolResult(permission);
  const readiness = await policyReadiness(env, selected.value.runnerId);
  if (!readiness.ok) return asToolResult(readiness.error);
  const startedAtMs = Date.now();
  const call = await callRunner(env, selected.value.runnerId, method, params, readiness.value.applied_revision, readiness.value.active_checksum);
  const result = call.ok ? runnerSuccess(projectRunnerResult(call.value, resultMode), selected.value) : runnerFailure(call.error, selected.value);
  const audit = await recordRunnerToolCall(env, {
    runnerId: selected.value.runnerId,
    clientId,
    method,
    params,
    result,
    startedAtMs,
    readiness: readiness.value,
  }).catch(() => ({ correlation_id: `call-${crypto.randomUUID()}`, audit_status: "unknown" as const }));
  return withAuditReceipt(result, audit);
}
