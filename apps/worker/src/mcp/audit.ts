import type { ActivePolicyReadiness } from "./contracts.js";
import type { AuditReceipt } from "./contracts.js";
import { boundedText } from "./results/envelope.js";
import { CONTENT_LIMIT } from "./results/envelope.js";
import { isRecord } from "./results/primitives.js";
import type { McpRequestEnv } from "./contracts.js";
import { registryPostCall } from "./transport.js";
import { safeJobIdentifierFromResult } from "./results/selection.js";
import { safeRunnerContextFromResult } from "./results/selection.js";
import { safeWorkspaceIdFromResult } from "./results/selection.js";

export async function recordRunnerToolCall(env: McpRequestEnv, input: {
  readonly runnerId: string;
  readonly clientId: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly result: unknown;
  readonly startedAtMs: number;
  readonly workspaceId?: string;
  readonly jobId?: string;
  readonly readiness: ActivePolicyReadiness;
}): Promise<AuditReceipt> {
  // Viewing Job metadata/output must not generate another history write.
  // Mutating Job control and execution keep their independent audit path.
  if (input.method === "job.get" || input.method === "job.logs" || input.method === "job.list") return {correlation_id:`call-${crypto.randomUUID()}`,audit_status:"disabled"};
  const structuredContent = isRecord(input.result) && isRecord(input.result.structuredContent) ? input.result.structuredContent : undefined;
  const errorValue = structuredContent === undefined ? undefined : structuredContent.error;
  const errorCode = errorValue !== undefined && isRecord(errorValue) && typeof errorValue.code === "string"
    ? errorValue.code
    : "internal_error";
  const result = isRecord(input.result) && input.result.isError === true
    ? { status: "error" as const, error_code: errorCode }
    : { status: "ok" as const, error_code: null };
  const completedAtMs = Date.now();
  const jobId = input.jobId ?? safeJobIdentifierFromResult(input.result) ?? null;
  const runnerContext = safeRunnerContextFromResult(input.result);
  const correlationId = `call-${crypto.randomUUID()}`;
  const recorded = await registryPostCall(env, `/runners/${encodeURIComponent(input.runnerId)}/mcp-calls`, {
    call_id: correlationId,
    client_id: input.clientId,
    method: input.method,
    workspace_id: input.workspaceId ?? safeWorkspaceIdFromResult(input.result),
    job_id: jobId,
    status: result.status,
    error_code: result.error_code,
    // Audit transports metadata only: never send tool arguments or output.
    result_runner_id: runnerContext?.runner_id ?? null,
    started_at_ms: input.startedAtMs,
    completed_at_ms: completedAtMs,
    duration_ms: completedAtMs - input.startedAtMs,
    epoch: input.readiness.connection_epoch,
    credential_version: input.readiness.credential_version,
    lifecycle_id: input.readiness.lifecycle_id,
    session_id: input.readiness.session_id,
    now_ms: completedAtMs,
  }, "audit");
  if (!recorded.ok) return { correlation_id: correlationId, audit_status: "unknown" };
  const status = isRecord(recorded.value) && (recorded.value.audit_status === "recorded" || recorded.value.audit_status === "degraded" || recorded.value.audit_status === "disabled") ? recorded.value.audit_status : "unknown";
  return { correlation_id: correlationId, audit_status: status };
}

export function withAuditReceipt(result: unknown, receipt: AuditReceipt): unknown {
  if (!isRecord(result) || !isRecord(result.structuredContent)) return result;
  const error = result.structuredContent.error;
  const structuredContent = { ...result.structuredContent, ...receipt,
    ...(result.isError === true && isRecord(error) && error.code === "tool_result_invalid"
      ? { error: { ...error, details: { ...(isRecord(error.details) ? error.details : {}), ...receipt } } } : {}),
  };
  return { ...result, structuredContent, content: [{ type: "text", text: boundedText(structuredContent, CONTENT_LIMIT) }] };
}
