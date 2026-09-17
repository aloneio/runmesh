import { activeRunnerTool } from "../dispatch.js";
import { diagnosticsTool } from "./diagnostics.js";
import { EditInputSchema } from "../catalog.js";
import { InspectInputSchema } from "../catalog.js";
import { inspectResultMode } from "../results/project.js";
import { MCP_RPC_ACTIONS } from "../actions.js";
import type { McpRequestEnv } from "../contracts.js";
import { z } from "zod";

export async function inspectTool(env: McpRequestEnv, clientId: string, params: z.output<typeof InspectInputSchema>, scopes: readonly string[]): Promise<unknown> {
  if (params.action === "diagnostics") return diagnosticsTool(env, clientId, params.workspace_id, scopes);
  const method = MCP_RPC_ACTIONS.inspect[params.action];
  const input: Record<string, unknown> = {
    workspace_id: params.workspace_id,
    ...(params.path === undefined ? {} : { path: params.path }),
    ...(params.action === "search" ? { query: params.query } : {}),
    ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    ...(params.action !== "search" || params.mode === undefined ? {} : { mode: params.mode }),
    ...(params.action !== "search" || params.case_sensitive === undefined ? {} : { case_sensitive: params.case_sensitive }),
    ...(params.action !== "search" || params.include_globs === undefined ? {} : { include_globs: params.include_globs }),
    ...(params.action !== "search" || params.exclude_globs === undefined ? {} : { exclude_globs: params.exclude_globs }),
    ...(params.action !== "search" || params.context_before === undefined ? {} : { context_before: params.context_before }),
    ...(params.action !== "search" || params.context_after === undefined ? {} : { context_after: params.context_after }),
    ...(params.action === "list" && params.max_results !== undefined ? { limit: params.max_results } : {}),
    ...(params.action === "search" && params.max_results !== undefined ? { max_results: params.max_results } : {}),
    ...(params.action === "git_diff" ? { max_bytes: 32 * 1024 } : {}),
    ...(params.action === "git_status" ? { max_bytes: 32 * 1024 } : {}),
    ...(params.action === "git_log" ? { ...(params.max_results === undefined ? {} : { limit: params.max_results }), max_bytes: 32 * 1024 } : {}),
    ...(params.action === "git_show" ? { revision: params.revision, max_bytes: 64 * 1024 } : {}),
    ...(params.action === "git_blame" ? {
      ...(params.start_line === undefined ? {} : { start_line: params.start_line }),
      ...(params.end_line === undefined ? {} : { end_line: params.end_line }),
      max_bytes: 64 * 1024,
    } : {}),
  };
  return activeRunnerTool(env, clientId, method, input, "read", inspectResultMode(params.action));
}

export async function editTool(env: McpRequestEnv, clientId: string, params: z.output<typeof EditInputSchema>): Promise<unknown> {
  const input: Record<string, unknown> = { ...params };
  delete input.preview;
  return activeRunnerTool(env, clientId, params.preview === true ? MCP_RPC_ACTIONS.edit.preview : MCP_RPC_ACTIONS.edit.apply, input, "edit", "edit");
}
