import { TOOL_SPECS, type ToolName } from "../apps/worker/src/mcp/catalog.js";
import { MCP_CATALOG_SUMMARY } from "../apps/worker/src/mcp/catalog-contract.js";
import { MCP_ACTION_REQUIREMENTS } from "../apps/worker/src/mcp/actions.js";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, RPC_OPERATION_METHODS } from "../packages/protocol/src/index.js";

/** Build/test tooling only; never imported by the Worker or Runner runtime. */
export const contractFacts = {
  protocol: { minimum: PROTOCOL_MIN_VERSION, current: PROTOCOL_CURRENT_VERSION },
  catalog_sha256: MCP_CATALOG_SUMMARY.sha256,
  tools: Object.keys(TOOL_SPECS),
  actions: MCP_ACTION_REQUIREMENTS.map(({ tool, action, method, scope }) => ({ tool, action, method, scope })),
  protected_rpc_methods: [...RPC_OPERATION_METHODS],
};

export interface ToolExample {
  readonly id: string; readonly tool: string; readonly action: string;
  readonly accepts: boolean; readonly arguments: Readonly<Record<string, unknown>>;
}
export function exampleProblem(example: ToolExample): string | undefined {
  if (!Object.hasOwn(TOOL_SPECS, example.tool)) return "unknown tool";
  if (example.accepts) {
    const action = ["inspect", "job", "context"].includes(example.tool) ? example.arguments.action
      : example.tool === "read" ? "read" : example.tool === "edit" ? example.arguments.preview === true ? "preview" : "apply"
        : example.tool === "shell" ? example.arguments.background === true ? "start" : "run" : undefined;
    if (action !== undefined && action !== example.action) return "example action does not match its arguments";
  }
  const accepted = TOOL_SPECS[example.tool as ToolName].inputSchema.safeParse(example.arguments).success;
  return accepted === example.accepts ? undefined : "example disagrees with the current input schema";
}
