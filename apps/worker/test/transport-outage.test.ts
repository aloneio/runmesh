import { env, runInDurableObject } from "cloudflare:test";
import { encodeWireFrame, PROTOCOL_CURRENT_VERSION as version, PROTOCOL_MIN_VERSION, type WireMessage } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";

const runner = "outage-runner";
function frame(kind: string): WireMessage {
  if (kind === "hello") return { type: "runner.hello", protocol_version: version, request_id: "hello-outage", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: version,
    runner: { runner_id: runner, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } } };
  if (kind === "heartbeat") return { type: "runner.heartbeat", protocol_version: version, runner_id: runner, sent_at_ms: Date.now(), active_job_ids: [] };
  if (kind === "sync") return { type: "runner.sync", protocol_version: version, runner_id: runner, sent_at_ms: Date.now(), sync_sequence: 1, jobs: [], workspaces: [] };
  if (kind === "event") return { type: "job.status", protocol_version: version, request_id: "job-outage", job: { runner_id: runner, job_id: "job-outage", workspace_id: "work", status: "running", created_at_ms: Date.now(), updated_at_ms: Date.now() } };
  return { type: "rpc.response", protocol_version: version, request_id: "rpc-outage", result: { private: "RESULT_MUST_NOT_BE_DELIVERED" } };
}
function socket(kind: string) {
  const close = vi.fn(), send = vi.fn();
  const ws = { close, send, deserializeAttachment: () => ({ runnerId: runner, sessionId: "outage-session", epoch: kind === "hello" ? 0 : 1, credentialVersion: 1, lifecycleId: "a".repeat(64), protocolVersion: version, authenticated: true, helloDeadlineMs: Date.now() + 10000 }) } as unknown as WebSocket;
  return { ws, close, send };
}

const failures = [429, 500, 502, 503, 504].flatMap((status) => ["hello", "heartbeat", "sync", "event", "session"].map((kind) => ({ status, kind })));
it.each(failures)("uses retryable close 1013 for $kind with upstream $status", async ({ status, kind }) => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`outage-transport-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance) => {
    const request = vi.spyOn(instance as any, "registryRequest").mockResolvedValue(new Response("private upstream error", { status }));
    const f = socket(kind);
    try {
      await instance.webSocketMessage(f.ws, encodeWireFrame(frame(kind)));
      expect(f.close).toHaveBeenCalledExactlyOnceWith(1013, "control plane temporarily unavailable");
      expect(f.send).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });
});

it.each(["hello", "heartbeat", "sync", "event", "session"])("retains fatal close 4001 for a verified stale %s identity", async (kind) => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`outage-revoke-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance) => {
    const request = vi.spyOn(instance as any, "registryRequest").mockResolvedValue(new Response("stale session", { status: 409 }));
    const f = socket(kind);
    try { await instance.webSocketMessage(f.ws, encodeWireFrame(frame(kind))); expect(f.close).toHaveBeenCalledWith(4001, "credentials revoked"); }
    finally { request.mockRestore(); }
  });
});

it.each([429, 500, 502, 503, 504, 401, 403, 200])("does not turn an authentication dependency failure (%s) into a fake 401", async (status) => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`outage-upgrade-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance) => {
    const request = vi.spyOn(instance as any, "registryRequest").mockResolvedValue(new Response("malformed or unavailable", { status }));
    try {
      const response = await instance.fetch(new Request(`https://runner.internal/runner/${runner}`, { headers: { Upgrade: "websocket", Authorization: "Bearer synthetic-runner-token" } }));
      expect(response.status).toBe(status === 401 || status === 403 ? 401 : status === 429 ? 429 : 503);
      expect(await response.text()).not.toContain("malformed or unavailable");
    } finally { request.mockRestore(); }
  });
});

it("rejects pending RPC replies when the session cannot be verified", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`outage-reply-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance) => {
    const request = vi.spyOn(instance as any, "registryRequest").mockRejectedValue(new Error("storage unavailable"));
    const f = socket("session"), resolve = vi.fn();
    const timer = setTimeout(() => {}, 10000);
    (instance as any).bridgeWaiters.set("rpc-outage", { resolve, timer, socket: f.ws });
    try {
      await instance.webSocketMessage(f.ws, encodeWireFrame(frame("session")));
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(resolve.mock.calls)).not.toContain("RESULT_MUST_NOT_BE_DELIVERED");
      expect(resolve.mock.calls[0]?.[0].type).toBe("rpc.error");
      expect(f.close).toHaveBeenCalledWith(1013, "control plane temporarily unavailable");
    } finally { clearTimeout(timer); request.mockRestore(); }
  });
});
