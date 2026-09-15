import { activeRunnerTool } from "../dispatch.js";
import { ContextInputSchema } from "../catalog.js";
import { failure } from "../results/envelope.js";
import { isToolSuccessResult } from "../results/envelope.js";
import { MCP_RPC_ACTIONS } from "../actions.js";
import type { McpRequestEnv } from "../contracts.js";
import { rpcOperation } from "@aloneio/runmesh-protocol";
import { safeContextStorageReport } from "@aloneio/runmesh-protocol";
import { z } from "zod";

export async function contextTool(env: McpRequestEnv, clientId: string, params: z.output<typeof ContextInputSchema>, scopes: readonly string[]): Promise<unknown> {
  const method = MCP_RPC_ACTIONS.context[params.action];
  const requirement = rpcOperation(method)!;
  const requiredScope = requirement.scope;
  if (!scopes.includes(requiredScope)) return failure("insufficient_scope", `This context action requires ${requiredScope}.`, `Authorize the MCP client again with ${requiredScope}.`);
  const result = await activeRunnerTool(env, clientId, method, params, requirement.permission, "context");
  if ((params.action === "storage" || params.action === "prune") && isToolSuccessResult(result)) {
    const report = safeContextStorageReport(result.structuredContent);
    const valid = report !== undefined && report.workspace_id === params.workspace_id && (params.action === "storage"
      ? report.storage_schema === 1
      : report.retention_schema === 1 && report.applied === (params.apply === true) && report.keep_days === params.keep_days && report.keep_revisions === params.keep_revisions && report.max_delete === (params.max_delete ?? 128));
    if (!valid) return failure("context_result_invalid", "The Runner did not provide a consistent Context storage receipt.", "Inspect local Context storage before another write; do not infer an empty store, completed cleanup or rollback from this response.", params.action === "prune" && params.apply === true ? "unknown" : "not_started");
  }
  return result;
}
