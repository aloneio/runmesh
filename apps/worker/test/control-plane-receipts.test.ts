import { expect, it, vi } from "vitest";
import { runnerEnvironment, runnerExecutionSnapshot } from "../src/application/runner-queries.js";
import { authThrottlePorts, runnerQueryPorts } from "../src/platform/control-plane-receipts.js";
import type { WorkerEnv } from "../src/platform/env.js";
import { loadAdminPageData } from "../src/http/admin-query.js";

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

const adminClient = { client_id: "client-1", label: "Retained client", scopes: ["coding:read"], revoked_at_ms: null, last_used_at_ms: null, active_runner_id: null };
const adminRunner = { runner_id: "runner-1", display_name: "Retained runner", state: "online", last_heartbeat_ms: null, configured_execution_mode: "dedicated_user", public_info: null };
function adminFeatureEnvironment(feature: (request: Request) => Response | Promise<Response>) {
  const calls: string[] = [];
  const env = environment(request => {
    const path = new URL(request.url).pathname; calls.push(path);
    if (path === "/auth/clients") return Response.json({ clients: [adminClient] });
    if (path === "/runners") return Response.json({ runners: [adminRunner] });
    if (path === "/status/features") return feature(request);
    throw new Error("Unexpected Registry path: " + path);
  });
  return { env, calls };
}

it.each(["headers", "body"] as const)("retains populated Admin data when optional feature %s stall", async phase => {
  vi.useFakeTimers();
  let entered!: () => void, release!: (response: Response) => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<Response>(resolve => { release = resolve; });
  let stream!: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal | undefined;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel });
  const { env, calls } = adminFeatureEnvironment(request => { signal = request.signal; entered(); return phase === "headers" ? pending : new Response(body); });
  let settled = false;
  const operation = loadAdminPageData(env, "clients").then(value => { settled = true; return value; });
  try {
    await requested;
    await vi.advanceTimersByTimeAsync(5001);
    expect(settled, "optional feature must not hold completed core data open past the existing read budget").toBe(true);
    expect(await operation).toMatchObject({ clients: [adminClient], runners: [adminRunner], notices: [{ title: "Feature health status unavailable" }] });
    expect(signal?.aborted).toBe(true);
    expect(calls.sort()).toEqual(["/auth/clients", "/runners", "/status/features"].sort());
    if (phase === "headers") { release(new Response(body)); await vi.advanceTimersByTimeAsync(0); }
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    if (phase === "headers") release(new Response(null, { status: 503 }));
    if (!cancel.mock.calls.length) stream.close();
    await operation;
    vi.useRealTimers();
  }
});

it.each(["malformed", "missing-features", "oversized", "non-success"] as const)("keeps feature health %s visible as unavailable without losing clients", async failure => {
  const { env, calls } = adminFeatureEnvironment(() => failure === "malformed" ? new Response("{")
    : failure === "missing-features" ? Response.json({})
    : failure === "oversized" ? Response.json({ features: [], untrusted: "x".repeat(16384) })
    : new Response("unavailable", { status: 503 }));
  expect(await loadAdminPageData(env, "clients")).toMatchObject({ clients: [adminClient], runners: [adminRunner], notices: [{ title: "Feature health status unavailable" }] });
  expect(calls).toHaveLength(3);
});

it.each([{ features: [] }, { features: [{ feature: "mcp_audit", disabled_until_ms: null, failure_count: 0, last_failure_at_ms: null, last_error: null }] }])("preserves healthy optional feature snapshots (%#)", async snapshot => {
  const { env } = adminFeatureEnvironment(() => Response.json(snapshot));
  expect(await loadAdminPageData(env, "clients")).toMatchObject({ clients: [adminClient], runners: [adminRunner], notices: [] });
});

it("accepts every producer feature with a maximum escaped error within the shared byte bound", async () => {
  const keys = ["job_recording", "mcp_audit", "mcp_usage_tracking", "auth_throttle", "maintenance_alarm"];
  const features = keys.map(feature => ({ feature, disabled_until_ms: Number.MAX_SAFE_INTEGER, failure_count: Number.MAX_SAFE_INTEGER, last_failure_at_ms: Number.MAX_SAFE_INTEGER, last_error: "\u0001".repeat(240) }));
  const { env } = adminFeatureEnvironment(() => Response.json({ features }));
  expect(new TextEncoder().encode(JSON.stringify({ features })).byteLength).toBeLessThan(16384);
  const data = await loadAdminPageData(env, "clients");
  expect(data?.clients).toEqual([adminClient]); expect(data?.runners).toEqual([adminRunner]); expect(data?.notices).toHaveLength(5);
  expect(data?.notices.some(notice => notice.title === "Feature health status unavailable")).toBe(false);
});
