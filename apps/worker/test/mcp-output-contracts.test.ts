import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOL_SPECS, type ToolName } from "../src/mcp/catalog.js";
import { defineToolHandlers, REGISTERED_TOOL_NAMES, type ToolHandlers } from "../src/mcp/handler-registry.js";
import { TOOL_OUTPUT_SCHEMAS } from "../src/mcp/output-contracts.js";
import { validateToolOutput, ACTION_OUTPUT_CONTRACTS } from "../src/mcp/action-output-contracts.js";
import { MCP_RPC_ACTIONS } from "../src/mcp/actions.js";
import { catalogContract } from "../src/mcp/catalog-contract.js";

const handlers = () => Object.fromEntries(REGISTERED_TOOL_NAMES.map(name => [name, async () => ({})])) as ToolHandlers;
it("AR05 every Runner action has an output contract", () => {
  for (const family of ["inspect", "job", "context", "shell", "edit"] as const) {
    const expected = Object.keys(MCP_RPC_ACTIONS[family]).sort();
    expect(Object.keys(ACTION_OUTPUT_CONTRACTS[family]).sort()).toEqual(expected);
  }
});
describe("AR05 handler completeness", () => {
  it("has exactly the existing ten tools with explicit output contracts", () => {
    expect(REGISTERED_TOOL_NAMES).toHaveLength(10);
    expect(Object.keys(TOOL_OUTPUT_SCHEMAS)).toEqual(REGISTERED_TOOL_NAMES);
    const registered = defineToolHandlers(handlers());
    expect(Object.isFrozen(registered)).toBe(true);
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
      expect(spec.outputSchema).toBe(TOOL_OUTPUT_SCHEMAS[name as ToolName]);
      const json = z.toJSONSchema(spec.outputSchema);
      expect(json.type).toBe("object");
      expect(json.additionalProperties).toBe(false);
      expect(Object.keys(json.properties ?? {}).length).toBeGreaterThan(3);
    }
  });
  it("rejects missing handlers before any registration", () => {
    const incomplete = handlers(); delete (incomplete as Partial<ToolHandlers>).read;
    expect(() => defineToolHandlers(incomplete)).toThrow("mcp_handler_contract_mismatch");
  });
  it.each(["not_a_tool", "constructor", "__proto__"])("rejects extra handler %s", key => {
    const extra = handlers(); Object.defineProperty(extra, key, { value: async () => ({}), enumerable: true });
    expect(() => defineToolHandlers(extra)).toThrow("mcp_handler_contract_mismatch");
  });
  it("does not invoke getters or accept inherited handlers", () => {
    let called = false;
    const invalid = handlers(); Object.defineProperty(invalid, "read", { get() { called = true; return async () => ({}); } });
    expect(() => defineToolHandlers(invalid)).toThrow("mcp_handler_contract_mismatch");
    expect(called).toBe(false);
    expect(() => defineToolHandlers(Object.create(handlers()))).toThrow("mcp_handler_contract_mismatch");
  });
  it("published directory uses the same concrete schemas", () => {
    for (const entry of catalogContract().tools) expect(entry.outputSchema).toEqual(z.toJSONSchema(TOOL_OUTPUT_SCHEMAS[entry.name as ToolName], { io: "output", target: "draft-2020-12" }));
  });
});

const validCases: Array<{ tool: ToolName; input: unknown; value: unknown }> = [
  { tool: "runner_list", input: {}, value: { runners: [] } },
  { tool: "runner_current", input: {}, value: { active_runner_id: null, active_runner_updated_at_ms: null, active_runner: null } },
  { tool: "runner_select", input: { runner_id: "r" }, value: { active_runner_id: "r", active_runner_updated_at_ms: 1, active_runner: { runner_id: "r", state: "online" }, changed: true } },
  { tool: "workspace_list", input: {}, value: { workspaces: [{ workspace_id: "w", enabled: true, permissions: { read: true, edit: false, shell: false, job_control: false } }] } },
  { tool: "inspect", input: { action: "list" }, value: { entries: [], next_cursor: null, truncated: false } },
  { tool: "inspect", input: { action: "search" }, value: { results: [], scanned: { bytes: 0 }, truncated: false } },
  { tool: "inspect", input: { action: "stat" }, value: { path: "a", type: "file", size: 0 } },
  { tool: "inspect", input: { action: "git_status" }, value: { entries: [], branch: { head: "dev" } } },
  { tool: "inspect", input: { action: "git_log" }, value: { commits: [] } },
  { tool: "inspect", input: { action: "git_diff" }, value: { diff: "", encoding: "utf-8" } },
  { tool: "inspect", input: { action: "git_show" }, value: { output: "x", revision: "abc1234" } },
  { tool: "inspect", input: { action: "git_blame" }, value: { output: "x", start_line: 1, end_line: 1 } },
  { tool: "read", input: {}, value: { data: "中文", offset: 0, next_cursor: null } },
  { tool: "edit", input: {}, value: { operations: [], changed_paths: [] } },
  { tool: "edit", input: { preview: true }, value: { preview_id: "a".repeat(64), previews: [] } },
  { tool: "shell", input: {}, value: { job_id: "j", status: "failed", completed: true, exit_code: 7, queue: { waiting: 2, limit: 32, per_client_limit: 8, running: 2, max_concurrent_jobs: 2, available_slots: 0 }, stdout: { available: false, error: { code: "log_unavailable" } } } },
  { tool: "job", input: { action: "get" }, value: { job_id: "j", status: "running" } },
  { tool: "job", input: { action: "cancel" }, value: { job_id: "j", status: "cancelling" } },
  { tool: "job", input: { action: "list" }, value: { jobs: [], source: "runner_live" } },
  { tool: "job", input: { action: "logs" }, value: { data: "", offset: 0, next_cursor: null } },
  { tool: "job", input: { action: "input" }, value: { accepted: 1 } },
  { tool: "context", input: { action: "bootstrap" }, value: { workspace_id: "w", state: "missing", context: null } },
  { tool: "context", input: { action: "read" }, value: { workspace_id: "w", context: { schema_version: 1, context_id: "ctx-1", goal: "hello" } } },
  { tool: "context", input: { action: "checkpoint" }, value: { workspace_id: "w", context: { schema_version: 2, context_id: "ctx-1", revision: 1 }, deduplicated: true } },
  { tool: "context", input: { action: "search" }, value: { state: "ready", results: [], next_cursor: null, scanned_records: 4 } },
  { tool: "context", input: { action: "rebuild" }, value: { rebuilt: true, records: 0 } },
];
describe("AR05 successful output boundaries", () => {
  it.each(["read", "checkpoint"])("rejects an empty or null Context %s record", action => {
    expect(validateToolOutput("context", { action }, { context: {} })).toBe(false);
    expect(validateToolOutput("context", { action }, { context: null })).toBe(false);
  });
  it("rejects unidentified list entries rather than reporting usable references", () => {
    expect(validateToolOutput("context", { action: "search" }, { results: [{}] })).toBe(false);
    expect(validateToolOutput("job", { action: "list" }, { jobs: [{}] })).toBe(false);
    expect(validateToolOutput("context", { action: "bootstrap" }, { state: "ready", context: null })).toBe(false);
    expect(validateToolOutput("context", { action: "rebuild" }, { rebuilt: true })).toBe(false);
  });
  for (const c of validCases) it(`accepts bounded ${c.tool} ${JSON.stringify(c.input)} without inventing absent legacy fields`, () => {
    expect(validateToolOutput(c.tool, c.input, c.value)).toBe(true);
    expect(validateToolOutput(c.tool, c.input, { ...(c.value as object), unexpected: "must-not-leak" })).toBe(false);
  });
  it.each(REGISTERED_TOOL_NAMES)("does not accept an empty success for %s", name => expect(validateToolOutput(name, {}, {})).toBe(false));
  it.each(REGISTERED_TOOL_NAMES)("preserves the explicit bounded truncation envelope for %s", name => {
    expect(validateToolOutput(name, {}, { truncated: true, data: "bounded JSON fragment", recovery_hint: "Use a smaller page." })).toBe(true);
    expect(validateToolOutput(name, {}, { truncated: true, data: "fragment" })).toBe(false);
  });
  it("rejects nested internal fields and does not coerce result scalars", () => {
    expect(validateToolOutput("shell", {}, { job_id: "j", status: "running", stdout: { data: "ok", cwd: "/private" } })).toBe(false);
    expect(validateToolOutput("shell", {}, { job_id: "j", status: "failed", exit_code: "0" })).toBe(false);
    expect(validateToolOutput("read", {}, { data: "x", offset: -1, next_cursor: null })).toBe(false);
    expect(validateToolOutput("workspace_list", {}, { workspaces: [{ workspace_id: "w", enabled: true, permissions: { read: "true" } }] })).toBe(false);
  });
});
