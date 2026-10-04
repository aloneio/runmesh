import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { mutateRunnerPolicy } from "../src/http/runner-policy.js";

const cases = [
  { name: "uncertain Registry write", change: 503, expected: 503, cancelled: ["change"] },
  { name: "missing commit evidence", evidence: false, expected: 503, cancelled: ["change"] },
  { name: "failed commit marker", mark: 503, expected: 503, cancelled: ["change", "mark"] },
  { name: "failed rejection recovery", change: 409, cancel: 503, expected: 503, cancelled: ["cancel", "change"] },
  { name: "pending policy push", push: 503, expected: 202, cancelled: ["push"], forwarded: "change" },
  { name: "rejected policy push", push: 409, expected: 409, cancelled: ["change"], forwarded: "push" },
  { name: "successful policy push", expected: 202, cancelled: [], forwarded: "change" },
  { name: "rejected fence", fence: 503, expected: 503, cancelled: [], forwarded: "fence" },
  { name: "recovered Registry rejection", change: 409, expected: 409, cancelled: [], forwarded: "change" },
] as const;

interface Scenario {
  readonly change?: number;
  readonly fence?: number;
  readonly mark?: number;
  readonly push?: number;
  readonly cancel?: number;
  readonly evidence?: boolean;
}

function fixture(scenario: Scenario, onCancel: () => void | Promise<void> = () => undefined) {
  const cancelled: string[] = [], calls: string[] = [];
  const response = (name: string, status: number) => status === 204 ? new Response(null, { status })
    : new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(name)); },
      cancel() { cancelled.push(name); return onCancel(); },
    }), { status });
  const localEnv = { ...env,
    RUNNER: { idFromName: () => "runner", get: () => ({ fetch: (request: Request) => {
      const path = new URL(request.url).pathname; calls.push(path);
      if (path === "/begin-policy-mutation") return response("fence", scenario.fence ?? 204);
      if (path === "/cancel-policy-mutation") return response("cancel", scenario.cancel ?? 204);
      if (path === "/mark-policy-committed") return response("mark", scenario.mark ?? 204);
      if (path === "/policy") return response("push", scenario.push ?? 204);
      throw new Error("Unexpected Runner request");
    } }) },
    REGISTRY: { idFromName: () => "registry", get: () => ({ fetch: (request: Request) => {
      const path = new URL(request.url).pathname; calls.push(path);
      if (path.endsWith("/mutation-state")) return Response.json({ mutation_committed: scenario.evidence ?? true,
        policy_status: "offline_pending", desired_revision: 1, desired_checksum: "a".repeat(64) });
      if (path === "/runners/r/permissions") return response("change", scenario.change ?? 200);
      throw new Error("Unexpected Registry request");
    } }) },
  } as unknown as typeof env;
  return { cancelled, calls, run: () => mutateRunnerPolicy(localEnv, "r", {
    path: "/runners/r/permissions", method: "POST", payload: {},
  }) };
}

it.each(cases)("releases unused responses after $name and preserves the returned body", async scenario => {
  const f = fixture(scenario);
  const result = await f.run();
  try {
    expect(result.status).toBe(scenario.expected);
    expect([...f.cancelled].sort()).toEqual([...scenario.cancelled].sort());
    expect(f.calls.filter(path => path === "/runners/r/permissions")).toHaveLength("fence" in scenario ? 0 : 1);
    if ("forwarded" in scenario) {
      const reader = result.body!.getReader();
      try { expect(new TextDecoder().decode((await reader.read()).value)).toBe(scenario.forwarded); }
      finally { await reader.cancel(); reader.releaseLock(); }
    }
  } finally { await result.body?.cancel(); }
});

it.each(["pending", "rejected"] as const)("does not wait for or propagate %s cleanup after a failed commit marker", async cleanup => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ mark: 503 }, () => cleanup === "pending" ? gate : Promise.reject(new Error("cleanup unavailable")));
  try {
    const result = await f.run();
    expect(result.status).toBe(503);
    expect([...f.cancelled].sort()).toEqual(["change", "mark"]);
    await result.body?.cancel();
  } finally { release(); }
}, 2_000);
