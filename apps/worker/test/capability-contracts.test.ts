import { expect, it } from "vitest";
import { canonicalJson, sha256Hex, RPC_OPERATION_METHODS, RPC_OPERATION_CONTRACT } from "@aloneio/runmesh-protocol";
import { TOOL_SPECS } from "../src/mcp/catalog.js";
import { MCP_RPC_ACTIONS, MCP_ACTION_REQUIREMENTS } from "../src/mcp/actions.js";
import { capabilityDiagnostics } from "../src/mcp/capability-diagnostics.js";
import { MCP_CATALOG_SUMMARY, catalogContract } from "../src/mcp/catalog-contract.js";
import worker from "../src/index.js";

const full = { read: true, edit: true, shell: true, job_control: true };
const allScopes = ["coding:read", "coding:write", "coding:exec"];
const report = () => ({ schema_version: 1, runner_version: "0.1.3", operation_contract_sha256: RPC_OPERATION_CONTRACT.sha256,
  supported_rpc_methods: [...RPC_OPERATION_METHODS], features: { job_queue: 1, job_history: 1, context_record: 2 }, max_concurrent_jobs: 1 });

it("R01 public catalog identity is available even when every storage binding is unavailable", async () => {
  const forbidden = () => { throw new Error("No storage access is allowed"); };
  const bindings = { REGISTRY: {idFromName:forbidden,get:forbidden},RUNNER:{idFromName:forbidden,get:forbidden},HISTORY_DB:{prepare:forbidden} } as any;
  const result = await worker.fetch(new Request("https://metadata.example/health"),bindings,{} as ExecutionContext);
  expect(result.status).toBe(200);
  expect((await result.json() as any).mcp_catalog).toEqual(MCP_CATALOG_SUMMARY);
});

it("catalog has a reproducible bounded fingerprint without creating new public tools", () => {
  expect(MCP_CATALOG_SUMMARY.tool_count).toBe(10);
  expect(MCP_CATALOG_SUMMARY.sha256).toBe(sha256Hex(canonicalJson(catalogContract())));
  expect(MCP_CATALOG_SUMMARY.tool_names).toEqual(Object.keys(TOOL_SPECS));
  expect(MCP_ACTION_REQUIREMENTS).toHaveLength(24);
  expect(new Set(MCP_ACTION_REQUIREMENTS.map(a => `${a.tool}.${a.action}`)).size).toBe(24);
  for (const action of MCP_ACTION_REQUIREMENTS) expect(RPC_OPERATION_METHODS).toContain(action.method);
  expect(new TextEncoder().encode(JSON.stringify(capabilityDiagnostics(report(), allScopes, full))).length).toBeLessThan(16 * 1024);
});

it("all inspect, Job and Context actions share the advertised schema's enumerations", () => {
  const contract = catalogContract();
  for (const name of ["inspect", "job", "context"] as const) {
    const schema = contract.tools.find(tool => tool.name === name)!.inputSchema as any;
    const actions = schema.properties?.action?.enum ?? (schema.oneOf ?? schema.anyOf).map((branch: any) => branch.properties.action.const);
    expect([...actions].sort()).toEqual(Object.keys(MCP_RPC_ACTIONS[name]).sort());
  }
  expect(TOOL_SPECS.job.annotations.readOnlyHint).toBe(false);
  expect(TOOL_SPECS.context.annotations.readOnlyHint).toBe(false);
});

it("old or malformed peers are unknown, never inferred from a product version", () => {
  for (const value of [undefined, null, {runner_version:"99.0.0"}, {...report(), hostname:"private"}, {...report(), supported_rpc_methods:["secret-url"]}]) {
    const result = capabilityDiagnostics(value, allScopes, full);
    expect(result.runner).toBeNull(); expect(result.contract_match).toBeNull();
    expect(result.actions.every(action => action.runner_support === "unknown")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private"); expect(JSON.stringify(result)).not.toContain("secret-url");
  }
});

it("separates implementation support, permission snapshot, missing reports and final job checks", () => {
  const result = capabilityDiagnostics(report(), ["coding:read"], full);
  expect(result.contract_match).toBe(true);
  expect(result.host_catalog_state).toBe("not_observed");
  expect(result.actions.find(action => action.method === "fs.read")).toMatchObject({runner_support:"supported", permission_snapshot:"permitted", requires_final_authorization:true});
  expect(result.actions.find(action => action.method === "job.cancel")).toMatchObject({runner_support:"supported", permission_snapshot:"denied", requires_job_check:true});
  expect(capabilityDiagnostics(report(), allScopes, undefined).actions.every(action => action.permission_snapshot === "unknown")).toBe(true);
  const partial = capabilityDiagnostics({...report(), supported_rpc_methods:["env.info"], operation_contract_sha256:"f".repeat(64)}, allScopes, full);
  expect(partial.contract_match).toBe(false);
  expect(partial.actions.find(action => action.method === "context.checkpoint")?.runner_support).toBe("unsupported");
});
