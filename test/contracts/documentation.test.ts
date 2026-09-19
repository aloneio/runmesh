import { expect, it } from "vitest";
import examples from "../../docs/tool-examples.json";
import { TOOL_SPECS } from "../../apps/worker/src/mcp/catalog.js";
import { contractFacts, exampleProblem } from "../../scripts/project-facts-entry.js";

it.each(examples)("AR08 documented example $id matches the real executable input schema", example => {
  expect(exampleProblem(example)).toBeUndefined();
});

it("AR08 examples cover every public tool and mapped action", () => {
  expect([...new Set(examples.filter(e => e.accepts).map(e => e.tool))].sort()).toEqual(Object.keys(TOOL_SPECS).sort());
  for (const action of contractFacts.actions) expect(examples.some(e => e.accepts && e.tool === action.tool && e.action === action.action)).toBe(true);
});

it("AR08 schema checks never call a handler or accept implicit tool removal", () => {
  expect(contractFacts.tools).toHaveLength(10);
  expect(exampleProblem({ id: "unknown", tool: "not-a-tool", action: "none", accepts: true, arguments: {} })).toBe("unknown tool");
});
