import { fromJsonSchema } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { TOOL_SPECS, RelativePathSchema, type ToolName } from "../src/mcp/catalog.js";
import { catalogContract } from "../src/mcp/catalog-contract.js";

const catalog = catalogContract();
const validators = new Map(catalog.tools.map(tool => [tool.name, fromJsonSchema(tool.inputSchema)]));
type Case = { name: string; tool: ToolName; input: Record<string, unknown>; valid: boolean };
const cases: Case[] = [];
function add(tool: ToolName, name: string, input: Record<string, unknown>, valid: boolean): void { cases.push({ tool, name, input, valid }); }
const work = { workspace_id: "work" };
const job = { job_id: "job-original", ...work };
const hash = "a".repeat(64), fileCursor = `f1:${hash}:0`, logCursor = `l1:${hash}:0`;

const minimal: Array<[ToolName, Record<string, unknown>]> = [
  ["runner_list", {}], ["runner_current", {}], ["runner_select", { runner_id: "runner-test" }], ["workspace_list", {}],
  ["inspect", { action: "list", ...work }], ["read", { ...work, path: "file" }], ["edit", { ...work, patch: "patch" }],
  ["shell", { ...work, command: "echo test" }], ["job", { action: "list" }], ["context", { action: "bootstrap", ...work }],
];
for (const [tool, input] of minimal) {
  add(tool, "minimal request", input, true);
  add(tool, "unknown fields", { ...input, unknown_field: true }, false);
}
for (const action of ["get", "logs", "cancel", "input"]) {
  const input = { action, ...job, ...(action === "input" ? { data: "x" } : {}) };
  add("job", `${action} with workspace binding`, input, true);
  add("job", `${action} without Job ID`, { ...input, job_id: undefined }, false);
}
for (const input of [{}, { close_stdin: false }]) add("job", "input requires data or close", { action: "input", ...job, ...input }, false);
for (const input of [{ data: "" }, { close_stdin: true }, { data: "x", close_stdin: false }]) add("job", "input accepted payload", { action: "input", ...job, ...input }, true);
for (const tool of ["read", "job"] as const) {
  const base = tool === "read" ? { ...work, path: "file" } : { ...job, action: "logs" };
  const cursor = tool === "read" ? fileCursor : logCursor;
  const consistency = tool === "read" ? "snapshot" : "append";
  add(tool, "start bound read", { ...base, consistency }, true);
  add(tool, "continue bound cursor", { ...base, cursor }, true);
  add(tool, "bound cursor with matching mode", { ...base, cursor, consistency }, true);
  add(tool, "bound cursor with offset", { ...base, cursor, offset: 0 }, false);
  add(tool, "bound cursor with live mode", { ...base, cursor, consistency: "live" }, false);
  add(tool, "numeric cursor with bound mode", { ...base, cursor: "0", consistency }, false);
  if (tool === "job") {
    add(tool, "bound cursor with tail", { ...base, cursor, tail: true }, false);
    add(tool, "bound cursor without tail", { ...base, cursor, tail: false }, true);
  }
}
for (const apply of [undefined, false, true]) for (const withHash of [false, true]) {
  const input = { action: "prune", ...work, keep_days: 30, keep_revisions: 3, ...(apply === undefined ? {} : { apply }), ...(withHash ? { expected_plan_hash: hash } : {}) };
  add("context", `prune apply=${String(apply)} hash=${withHash}`, input, (apply === true) === withHash);
}
for (const kind of ["job", "test", "commit", "note"]) for (const withJob of [false, true]) {
  add("context", `evidence kind=${kind} job=${withJob}`, { action: "checkpoint", ...work, turn_id: "turn-test", goal: "Safe goal", evidence: [{ kind, ...(withJob ? { job_id: "job-original" } : {}) }] }, (kind === "job") === withJob);
}
for (const preview of [undefined, false, true]) for (const withId of [false, true]) {
  add("edit", `preview=${String(preview)} id=${withId}`, { ...work, patch: "patch", ...(preview === undefined ? {} : { preview }), ...(withId ? { preview_id: hash } : {}) }, !(preview === true && withId));
}
for (const path of ["../file", "a/../file", "a\\..\\file", "/root", "C:\\root", "\\root", "file\u0000.txt"]) add("read", `unsafe path ${JSON.stringify(path)}`, { ...work, path }, false);
for (const path of [".", "file", "dir/file", "中文/文件", "..file", "name\nwith-newline"]) add("read", `safe path ${JSON.stringify(path)}`, { ...work, path }, true);
add("shell", "wait budget too large", { ...work, command: "echo test", wait_ms: 8001 }, false);
add("inspect", "glob with NUL", { action: "search", ...work, query: "x", include_globs: ["x\u0000"] }, false);

describe("agent-visible JSON Schema and runtime acceptance", () => {
  it.each(cases)("$tool: $name", async ({ tool, input, valid }) => {
    // Exercise wire JSON, not JavaScript-only undefined properties.
    const json: unknown = JSON.parse(JSON.stringify(input));
    expect(TOOL_SPECS[tool].inputSchema.safeParse(json).success, "runtime").toBe(valid);
    const result = await validators.get(tool)!["~standard"].validate(json);
    expect(result.issues === undefined, "published schema").toBe(valid);
  });
  it.each(["inspect", "job", "context"])("exposes root properties without weakening %s action branches", name => {
    const input = catalog.tools.find(tool => tool.name === name)!.inputSchema;
    expect(input.type).toBe("object");
    expect(input.additionalProperties).toBe(false);
    expect(input.properties?.action).toMatchObject({ type: "string", enum: expect.any(Array) });
    expect(input.properties?.workspace_id).toBeDefined();
    expect(input.required).toContain("action");
    expect(input.oneOf ?? input.anyOf).toBeDefined();
  });
  it("does not advertise arbitrary host shell execution as non-destructive", () => {
    expect(TOOL_SPECS.shell.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
  it("keeps the published path regex equivalent to the prior traversal guard", () => {
    const atoms = ["", ".", "..", "...", "a", "C:", "中文", "\n", "\u0000"];
    for (const first of atoms) for (const separator of ["", "/", "\\"]) for (const last of atoms) {
      const path = first + separator + last;
      const expected = path.length > 0 && !path.includes("\0") && !path.startsWith("/") && !path.startsWith("\\") && !/^[A-Za-z]:/.test(path) && !path.split(/[\\/]/).includes("..");
      expect(RelativePathSchema.safeParse(path).success, JSON.stringify(path)).toBe(expected);
    }
  });
});
