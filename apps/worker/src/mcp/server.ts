import { activeRunnerTool } from "./dispatch.js";
import { activeWorkspaceList } from "./selection.js";
import { asToolResult } from "./results/envelope.js";
import { boundedReadParams } from "./request-values.js";
import { contextTool } from "./handlers/context.js";
import { defineToolHandlers } from "./handler-registry.js";
import { editTool } from "./handlers/files.js";
import { failure } from "./results/envelope.js";
import { failureWithDetails } from "./results/envelope.js";
import { gatedRunnerList } from "./selection.js";
import { getActiveRunnerSelection } from "./selection.js";
import { inspectTool } from "./handlers/files.js";
import { internalHeaders } from "../security.js";
import { isConfiguredSecret } from "../security.js";
import { isRecord } from "./results/primitives.js";
import { isToolSuccessResult } from "./results/envelope.js";
import { jobTool } from "./handlers/jobs.js";
import { MCP_CATALOG_METADATA } from "./catalog-contract.js";
import { MCP_RPC_ACTIONS } from "./actions.js";
import type { McpAuth } from "./contracts.js";
import type { McpClientActiveRunner } from "../contracts/runner-selection.js";
import type { McpRequestEnv } from "./contracts.js";
import { McpServer } from "@modelcontextprotocol/server";
import { PRODUCT_VERSION } from "../generated-version.js";
import { reauthorizePrincipal } from "./reauthorization.js";
import { REGISTERED_TOOL_NAMES } from "./handler-registry.js";
import { safeJobIdentifier } from "./results/primitives.js";
import { safeRunnerContext } from "./results/selection.js";
import { safeSelectionValue } from "./results/selection.js";
import { selectActiveRunner } from "./selection.js";
import type { ServerContext } from "@modelcontextprotocol/server";
import { shellTool } from "./handlers/shell.js";
import { success } from "./results/envelope.js";
import { SUPPORTED_SCOPES } from "./catalog.js";
import { TOOL_SPECS } from "./catalog.js";
import type { ToolHandlers } from "./handler-registry.js";
import type { ToolName } from "./catalog.js";
import { validateToolOutput } from "./action-output-contracts.js";
import type { WorkerEnv } from "../platform/env.js";
import { z } from "zod";

/**
 * Fresh server factory target for createMcpHandler. Every HTTP request receives
 * an isolated McpServer and the default stateless 2025 compatibility lane.
 */
export function createCodingMcpServer(rawEnv: WorkerEnv, auth: McpAuth): McpServer {
  const env: McpRequestEnv = { ...rawEnv, mcpPrincipal: { client_id: auth.clientId, secret_version: auth.extra?.secret_version } };
  const server = new McpServer({ name: "runmesh", version: PRODUCT_VERSION });

  const handlers = defineToolHandlers({
    runner_list: async () => gatedRunnerList(env, auth.clientId),
    runner_current: async () => {
      const selection = await getActiveRunnerSelection(env, auth.clientId);
      return selection.ok ? success(safeSelectionValue(selection.value)) : asToolResult(selection);
    },
    runner_select: async ({ runner_id, confirm_switch }) => {
      const selection = await selectActiveRunner(env, auth.clientId, runner_id, confirm_switch === true);
      if (selection.ok) {
        const result = selection.value as { selection: McpClientActiveRunner; changed: boolean };
        return success({ ...safeSelectionValue(result.selection), changed: result.changed });
      }
      if (selection.error.code === "runner_switch_confirmation_required") {
        const current = selection.error.details;
        return failureWithDetails(selection.error.code, selection.error.message, selection.error.hint, current === undefined ? {} : { current_active_runner: safeSelectionValue(current) });
      }
      return asToolResult(selection);
    },
    workspace_list: async () => activeWorkspaceList(env, auth.clientId),
    inspect: async (params, scopes) => inspectTool(env, auth.clientId, params, scopes),
    read: async params => activeRunnerTool(env, auth.clientId, MCP_RPC_ACTIONS.read.read, boundedReadParams(params, 32 * 1024), "read", "read"),
    edit: async params => editTool(env, auth.clientId, params),
    shell: async params => shellTool(env, auth.clientId, params),
    job: async (params, scopes) => jobTool(env, auth.clientId, params, scopes),
    context: async (params, scopes) => contextTool(env, auth.clientId, params, scopes),
  });
  for (const name of REGISTERED_TOOL_NAMES) register(server, name, handlers[name]);

  return server;

  function register<Name extends ToolName>(target: McpServer, name: Name, action: ToolHandlers[Name]): void {
    const spec = TOOL_SPECS[name];
    type Input = z.output<(typeof TOOL_SPECS)[Name]["inputSchema"]>;
    (target.registerTool as unknown as (toolName: string, config: Record<string, unknown>, callback: (input: Input, context: ServerContext) => Promise<unknown>) => unknown)(name, { description: spec.description, inputSchema: spec.inputSchema, outputSchema: spec.outputSchema, annotations: spec.annotations, _meta: MCP_CATALOG_METADATA }, async (input, _context) => {
      // The URL credential can be rotated while a body or SDK import is
      // awaited. Re-read the exact generation and scopes before every tool.
      const live = await reauthorizePrincipal(async signal => {
        if (!isConfiguredSecret(env.INTERNAL_CONTROL_SECRET)) throw new Error("internal service unavailable");
        const path = "/auth/mcp/revalidate", body = JSON.stringify(env.mcpPrincipal);
        const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", path, body);
        return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers, body, signal }));
      }, env.mcpPrincipal);
      if (live.state === "unavailable") {
        return failure("registry_unavailable", "Current authorization could not be checked because its dependency is temporarily unavailable.", "Keep the current connection and retry after the dependency recovers; no operation was dispatched.", "not_started");
      }
      if (live.state === "malformed") {
        return failure("authorization_response_invalid", "The authorization dependency returned an invalid response.", "Ask the operator to check the control plane; no operation was dispatched and credential revocation was not established.", "not_started");
      }
      if (live.state === "denied") {
        return failure("permission_denied", "The MCP credential is no longer authorized.", "Use the currently authorized MCP connection; do not retry a revoked URL.");
      }
      if (live.state !== "allowed") return failure("registry_unavailable", "Current authorization could not be checked.", "Check the control plane before retrying.", "not_started");
      const scopes = live.scopes;
      const requiredScope = "scope" in spec ? spec.scope : undefined;
      if (requiredScope !== undefined && !scopes.includes(requiredScope)) {
        return failure("insufficient_scope", `This tool requires ${requiredScope}.`, `Authorize the MCP client again with ${requiredScope}.`);
      }
      try {
        return verifyToolResult(name, input, await action(input, scopes));
      } catch {
        return failure("internal_error", "The MCP tool could not confirm the operation outcome.", "Inspect the existing Job or change receipt before deciding what to do next; do not blindly repeat a write or command. Contact the operator if the outcome cannot be established.");
      }
    });
  }
}

/** Preserve the existing auth/error wrapper; validate only successful public
 * results. A broken output contract never authorizes retrying a mutation. */
function verifyToolResult(name: ToolName, input: unknown, result: unknown): unknown {
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

export const MCP_TOOL_NAMES = Object.freeze(Object.keys(TOOL_SPECS));

export const MCP_SUPPORTED_SCOPES = SUPPORTED_SCOPES;

export type { McpAuth } from "./contracts.js";
export { safeJobMetadata } from "./results/jobs.js";
export { safeJobLogResult } from "./results/jobs.js";
export { safeJobInputResult } from "./results/jobs.js";
export { safeShellResult } from "./results/jobs.js";
export { safeReadResult } from "./results/files.js";
export { safeContextResult } from "./results/context.js";
export type { InspectResultKind } from "./contracts.js";
export { safeInspectResult } from "./results/files.js";
export { safeEditResult } from "./results/files.js";
export { policyPending } from "./authorization.js";
