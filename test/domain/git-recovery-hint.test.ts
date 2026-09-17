import { expect, it } from "vitest";
import { failure, hintFor } from "../../apps/worker/src/mcp/results/envelope.js";
import { failureMetadata } from "../../packages/protocol/src/failure.js";

it.each([undefined, "not_started", "unknown"] as const)("offers safe Git configuration guidance for operation state %s", (state) => {
  const hint = hintFor("git_unavailable", state);
  expect(hint).toContain("administrator");
  expect(hint).toContain("non-filesystem-root workspace");
  expect(hint).toContain("Do not weaken executable isolation");
  const result = failure("git_unavailable", "The runner rejected the request.", hint, state);
  expect(JSON.stringify(result)).not.toMatch(/\/usr\/bin|\/workspace|\.git\/config|shell/);
  expect(result.structuredContent).toMatchObject({ error: { code: "git_unavailable", recovery_hint: hint,
    failure_class: "availability", operation_state: state ?? "not_started", next_action: "contact_operator" } });
  expect(JSON.stringify(result)).not.toContain("retry_after_ms");
});

it.each(["unknown", "running", "committed"] as const)("does not erase an explicit Git operation state %s", (state) => {
  expect(failureMetadata("git_unavailable", state)).toEqual({ failure_class: "availability", operation_state: state, next_action: "contact_operator" });
});
