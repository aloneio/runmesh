import { canonicalJson, sha256Hex, RPC_OPERATION_CONTRACT } from "@aloneio/runmesh-protocol";
import { z } from "zod";
import { MCP_ACTION_REQUIREMENTS } from "./actions.js";
import { TOOL_SPECS, SafeOutputSchema } from "./catalog.js";

/** Public schema/annotation fingerprint, not an authorization or source-code
 * signature. Cross-field Zod refinements still execute at the input boundary. */
export function catalogContract() {
  return { schema_version: 1, operation_contract: RPC_OPERATION_CONTRACT,
    tools: Object.entries(TOOL_SPECS).map(([name, spec]) => ({ name, description: spec.description,
      inputSchema: { type: "object", ...z.toJSONSchema(spec.inputSchema, { io: "input", target: "draft-2020-12" }) },
      outputSchema: z.toJSONSchema(SafeOutputSchema, { io: "output", target: "draft-2020-12" }), annotations: spec.annotations,
      scope: "scope" in spec ? spec.scope : null,
      actions: MCP_ACTION_REQUIREMENTS.filter(action => action.tool === name) })) };
}

// Compute once per isolate, never per invocation or heartbeat. No I/O/timers.
const contract = catalogContract();
export const MCP_CATALOG_SUMMARY = Object.freeze({ schema_version: 1,
  sha256: sha256Hex(canonicalJson(contract)), tool_names: Object.freeze(contract.tools.map(tool => tool.name)),
  tool_count: contract.tools.length, action_count: MCP_ACTION_REQUIREMENTS.length,
  operation_contract_sha256: RPC_OPERATION_CONTRACT.sha256 });

export const MCP_CATALOG_METADATA = Object.freeze({ "io.runmesh/catalog": Object.freeze({
  schema_version: 1, sha256: MCP_CATALOG_SUMMARY.sha256,
}) });
