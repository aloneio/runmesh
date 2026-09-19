import { expect, it, vi } from "vitest";
import { verifyMcpClient } from "../src/application/mcp-identity.js";
import { ControlPlaneUnavailableError } from "../src/control-plane-errors.js";
import type { WorkerEnv } from "../src/platform/env.js";
import { createEnrollmentCode } from "../src/application/enrollment.js";

const principal = { client_id: "client-1", label: "Test client", scopes: ["coding:read"], secret_version: 1 };
function environment(fetch: (request: Request) => Response | Promise<Response>): WorkerEnv {
  return { INTERNAL_CONTROL_SECRET: "synthetic-internal-secret-not-for-production", REGISTRY: { idFromName: () => "registry", get: () => ({ fetch }) } } as unknown as WorkerEnv;
}

it("accepts a complete credential identity once and omits extraneous fields", async () => {
  const fetch = vi.fn(() => Response.json({ ...principal, token: "private" }));
  expect(await verifyMcpClient(environment(fetch), "a".repeat(64))).toEqual(principal);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([201, 202, 206, 429, 500, 503])("does not grant admission for an unexpected %s receipt", async status => {
  const fetch = vi.fn(() => Response.json(principal, { status }));
  await expect(verifyMcpClient(environment(fetch), "a".repeat(64))).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  { client_id: "../invalid" }, { client_id: "" }, { label: "" }, { label: "x".repeat(257) },
  { scopes: ["coding:read", "coding:read"] }, { scopes: [] }, { scopes: ["admin"] }, { secret_version: 0 },
])("rejects malformed identity fields without claiming revocation: %j", async fields => {
  await expect(verifyMcpClient(environment(() => Response.json({ ...principal, ...fields })), "a".repeat(64))).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
});

it("bounds credential response bytes and cancels the untrusted stream", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(16_385)); }, cancel });
  await expect(verifyMcpClient(environment(() => new Response(body)), "a".repeat(64))).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  expect(cancel).toHaveBeenCalledOnce();
});

it("bounds an initial admission dependency that never returns its body", async () => {
  vi.useFakeTimers();
  let entered!: () => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const cancel = vi.fn();
  const pending = verifyMcpClient(environment(() => { entered(); return new Response(new ReadableStream({ cancel })); }), "a".repeat(64));
  const rejected = expect(pending).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  try {
    await requested; await vi.advanceTimersByTimeAsync(5001); await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("distinguishes an explicit invalid credential from a missing dependency route", async () => {
  expect(await verifyMcpClient(environment(() => Response.json({ error: { code: "invalid_mcp_credential" } }, { status: 404 })), "a".repeat(64))).toBeUndefined();
  await expect(verifyMcpClient(environment(() => new Response("Not found", { status: 404 })), "a".repeat(64))).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
});

it.each([202, 503, "wrong-runner", "wrong-enrollment", "invalid-window"] as const)("never returns an enrollment code from an unconfirmed %s receipt", async failure => {
  const fetch = vi.fn(async (request: Request) => {
    const input = await request.json() as Record<string, unknown>;
    return Response.json({ runner_id: failure === "wrong-runner" ? "other" : "runner-1",
      enrollment_id: failure === "wrong-enrollment" ? "other" : input.enrollment_id,
      created_at_ms: 10, not_before_ms: 10, expires_at_ms: failure === "invalid-window" ? 9 : 20,
    }, { status: typeof failure === "number" ? failure : 200 });
  });
  expect(await createEnrollmentCode(environment(fetch), "runner-1")).toMatchObject({ ok: false, deterministic: false });
  expect(fetch).toHaveBeenCalledOnce();
});

it("returns a new enrollment code only for its matching completed receipt", async () => {
  const fetch = vi.fn(async (request: Request) => {
    const input = await request.json() as Record<string, unknown>;
    return Response.json({ runner_id: "runner-1", enrollment_id: input.enrollment_id, created_at_ms: 10, not_before_ms: 10, expires_at_ms: 20 });
  });
  expect(await createEnrollmentCode(environment(fetch), "runner-1")).toMatchObject({ ok: true, code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) });
});
