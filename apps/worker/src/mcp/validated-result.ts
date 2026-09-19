import { safeContextStorageReport } from "@aloneio/runmesh-protocol";
import { failure } from "./results/envelope.js";
import { failureWithDetails, isToolSuccessResult } from "./results/envelope.js";
import { isRecord, safeJobIdentifier } from "./results/primitives.js";
import { safeRunnerContext } from "./results/selection.js";
import { validateToolOutput } from "./action-output-contracts.js";
import { MCP_ACTION_REQUIREMENTS } from "./actions.js";
import type { ToolName } from "./catalog.js";

/** Preserve the existing auth/error wrapper; validate only successful public
 * results. A broken output contract never authorizes retrying a mutation. */
export function verifyToolResult(name: ToolName, input: unknown, result: unknown): unknown {
  if (isRecord(result) && result.isError === true) return result;
  if (isToolSuccessResult(result) && validateToolOutput(name, input, result.structuredContent)) return result;
  const value = isToolSuccessResult(result) ? result.structuredContent : {};
  const receipt: Record<string, unknown> = {};
  for (const key of ["job_id", "workspace_id", "correlation_id"] as const) {
    const id = safeJobIdentifier(value[key]); if (id !== undefined) receipt[key] = id;
  }
  if (value.runner_context !== undefined) receipt.runner_context = safeRunnerContext(value.runner_context);
  if (["recorded", "degraded", "unknown", "disabled"].includes(String(value.audit_status))) receipt.audit_status = value.audit_status;
  return failureWithDetails("tool_result_invalid", "The tool did not return the documented result; no success is inferred.", "Inspect the original Job or workspace state. Do not repeat a mutation, input or cancellation based on this response.", receipt, "unknown");
}

/** Validate before persisting audit success, using the same final public contract. */
export function verifyRunnerToolResult(method: string, params: Record<string, unknown>, result: unknown): unknown {
  if ((method === "context.storage" || method === "context.prune") && isToolSuccessResult(result)) {
    const report = safeContextStorageReport(result.structuredContent);
    const valid = report !== undefined && report.workspace_id === params.workspace_id && (method === "context.storage"
      ? report.storage_schema === 1
      : report.retention_schema === 1 && report.applied === (params.apply === true) && report.keep_days === params.keep_days && report.keep_revisions === params.keep_revisions && report.max_delete === (params.max_delete ?? 128));
    if (!valid) return failure("context_result_invalid", "The Runner did not provide a consistent Context storage receipt.", "Inspect local Context storage before another write; do not infer an empty store, completed cleanup or rollback from this response.", method === "context.prune" && params.apply === true ? "unknown" : "not_started");
  }
  const binding = MCP_ACTION_REQUIREMENTS.find(value => value.method === method);
  if (binding === undefined) return failureWithDetails("tool_result_invalid", "The operation has no public result contract.", "Inspect the original operation; do not replay a mutation.", {}, "unknown");
  return verifyToolResult(binding.tool as ToolName, { ...params, action: binding.action, ...(binding.tool === "shell" ? { background: binding.action === "start" } : {}), ...(binding.tool === "edit" ? { preview: binding.action === "preview" } : {}) }, result);
}
