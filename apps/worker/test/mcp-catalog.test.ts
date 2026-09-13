import { describe, expect, it } from "vitest";
import { SUPPORTED_SCOPES, TOOL_SPECS } from "../src/mcp/catalog.js";

describe("MCP tool catalog", () => {
  it("keeps the stable public tool surface in one catalog", () => {
    expect(Object.keys(TOOL_SPECS).sort()).toEqual([
      "edit", "inspect", "job", "read", "runner_current", "runner_list", "runner_select", "shell", "workspace_list",
    ]);
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
      expect(spec.description, name).toBeTruthy();
      expect(spec.inputSchema, name).toBeDefined();
      expect(spec.annotations, name).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      if ("scope" in spec && spec.scope !== undefined) expect(SUPPORTED_SCOPES).toContain(spec.scope);
    }
  });

  it("rejects unknown fields and preserves action-specific schemas", () => {
    expect(TOOL_SPECS.runner_list.inputSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(TOOL_SPECS.inspect.inputSchema.safeParse({ action: "search", workspace_id: "workspace", query: "needle", context_before: 2 }).success).toBe(true);
    expect(TOOL_SPECS.inspect.inputSchema.safeParse({ action: "stat", workspace_id: "workspace", query: "needle" }).success).toBe(false);
    expect(TOOL_SPECS.edit.inputSchema.safeParse({ workspace_id: "workspace", patch: "*** Begin Patch\n*** End Patch", preview: true, preview_id: "a".repeat(64) }).success).toBe(false);
  });
});
