import { expect, it } from "vitest";
import { failure, hintFor } from "../../apps/worker/src/mcp/results/envelope.js";

it.each([undefined, "not_started", "unknown"] as const)("offers safe Git configuration guidance for operation state %s", (state) => {
  const hint = hintFor("git_unavailable", state);
  expect(hint).toContain("administrator");
  expect(hint).toContain("non-filesystem-root workspace");
  expect(hint).toContain("Do not weaken executable isolation");
  const result = failure("git_unavailable", "The runner rejected the request.", hint, state);
  expect(JSON.stringify(result)).not.toMatch(/\/usr\/bin|\/workspace|\.git\/config|shell/);
  expect(result.structuredContent).toMatchObject({ error: { code: "git_unavailable", recovery_hint: hint } });
});
