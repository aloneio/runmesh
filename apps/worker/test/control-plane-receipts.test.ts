import { expect, it, vi } from "vitest";
import { runnerEnvironment, runnerExecutionSnapshot } from "../src/application/runner-queries.js";
import { authThrottlePorts, runnerQueryPorts } from "../src/platform/control-plane-receipts.js";
import type { WorkerEnv } from "../src/platform/env.js";

const checksum = "a".repeat(64);
const ready = { ok: true, policy_status: "applied", desired_revision: 1, applied_revision: 1, runner_reported_policy_revision: 1,
  desired_checksum: checksum, active_checksum: checksum, runner_reported_policy_checksum: checksum };
function environment(fetch: (request: Request) => Response | Promise<Response>, rpc = fetch): WorkerEnv {
  return { INTERNAL_CONTROL_SECRET: "synthetic-receipts-secret-not-for-production",
    REGISTRY: { idFromName: () => "registry", get: () => ({ fetch }) },
    RUNNER: { idFromName: (id: string) => id, get: () => ({ fetch: rpc }) } } as unknown as WorkerEnv;
}

it.each([201, 202, 206, 503])("cancels a non-authoritative Runner snapshot %s without waiting for its body", async status => {
  const cancel = vi.fn(), fetch = vi.fn(() => new Response(new ReadableStream({ cancel }), { status }));
  expect(await runnerExecutionSnapshot(runnerQueryPorts(environment(fetch)), "runner-1")).toEqual({ status });
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
});
it.each(["registry", "runner"] as const)("bounds an unfinished %s diagnostic body and propagates cancellation", async dependency => {
  vi.useFakeTimers();
  let entered!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | undefined;
  const cancel = vi.fn(), hanging = vi.fn((request: Request) => { signal = request.signal; entered(); return new Response(new ReadableStream({ cancel })); });
  const env = dependency === "registry" ? environment(hanging) : environment(() => Response.json(ready), hanging);
  const result = dependency === "registry" ? runnerExecutionSnapshot(runnerQueryPorts(env), "runner-1") : runnerEnvironment(runnerQueryPorts(env), "runner-1");
  try {
    await requested;
    await vi.advanceTimersByTimeAsync(5001);
    if (dependency === "registry") expect(await result).toEqual({ status: 503 });
    else expect(await result).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(hanging).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
it("keeps valid larger Runner metadata within the protocol response budget", async () => {
  const value = { runner: { runner_id: "runner-1", configured_execution_mode: "dedicated_user", metadata: { value: "x".repeat(32_768) } }, lifecycle_id: "lifecycle-1" };
  expect(await runnerExecutionSnapshot(runnerQueryPorts(environment(() => Response.json(value))), "runner-1")).toMatchObject({ status: 200, snapshot: { lifecycleId: "lifecycle-1" } });
});
it("hashes edge sources consistently and omits raw addresses from Registry requests", async () => {
  const payloads: Record<string, unknown>[] = [];
  const env = environment(async request => { payloads.push(await request.json() as Record<string, unknown>); return Response.json({ allowed: true, retry_after_ms: 0 }); });
  await authThrottlePorts(env, "2001:DB8::1").check("login");
  await authThrottlePorts(env, "2001:db8::1").record("login", true);
  await authThrottlePorts(env, null).check("setup");
  await authThrottlePorts(env, "invalid").check("setup");
  expect(payloads[0]?.source_hash).toBe(payloads[1]?.source_hash);
  expect(payloads[2]?.source_hash).toBe(payloads[3]?.source_hash);
  expect(payloads[0]?.source_hash).not.toBe(payloads[2]?.source_hash);
  expect(JSON.stringify(payloads)).not.toMatch(/2001|DB8|invalid/);
  expect(payloads[1]).toMatchObject({ kind: "login", success: true });
});
