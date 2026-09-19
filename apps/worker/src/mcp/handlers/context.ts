import { activeRunnerTool } from "../dispatch.js";
import { ContextInputSchema } from "../catalog.js";
import { failure } from "../results/envelope.js";
import { MCP_RPC_ACTIONS } from "../actions.js";
import type { McpRequestEnv } from "../contracts.js";
import { rpcOperation } from "@aloneio/runmesh-protocol";
import { z } from "zod";

export async function contextTool(env: McpRequestEnv, clientId: string, params: z.output<typeof ContextInputSchema>, scopes: readonly string[]): Promise<unknown> {
  const method = MCP_RPC_ACTIONS.context[params.action];
  const requirement = rpcOperation(method)!;
  const requiredScope = requirement.scope;
  if (!scopes.includes(requiredScope)) return failure("insufficient_scope", `This context action requires ${requiredScope}.`, `Authorize the MCP client again with ${requiredScope}.`);
  return activeRunnerTool(env, clientId, method, params, requirement.permission, "context");
}
