import { RunnerDO } from "../src/runner-do.js";
import { BridgeReplies } from "../src/platform/bridge-replies.js";
import { env, runInDurableObject } from "cloudflare:test";
import { encodeWireFrame, PROTOCOL_CURRENT_VERSION as version, PROTOCOL_MIN_VERSION, type WireMessage } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";

const runner = "outage-runner";
const sessionFrames = ["hello", "heartbeat", "sync", "event", "session", "policy"];
function frame(kind: string): WireMessage {
  if (kind === "hello") return { type: "runner.hello", protocol_version: version, request_id: "hello-outage", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: version,
    runner: { runner_id: runner, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } } };
  if (kind === "heartbeat") return { type: "runner.heartbeat", protocol_version: version, runner_id: runner, sent_at_ms: Date.now(), active_job_ids: [] };
  if (kind === "sync") return { type: "runner.sync", protocol_version: version, runner_id: runner, sent_at_ms: Date.now(), sync_sequence: 1, jobs: [], workspaces: [] };
  if (kind === "event") return { type: "job.status", protocol_version: version, request_id: "job-outage", job: { runner_id: runner, job_id: "job-outage", workspace_id: "work", status: "running", created_at_ms: Date.now(), updated_at_ms: Date.now() } };
  if (kind === "policy") return { type: "runner.policy_ack", protocol_version: version, runner_id: runner,
    desired_revision: 1, desired_checksum: "b".repeat(64), applied_revision: 1, applied_checksum: "b".repeat(64),
    runner_reported_policy_revision: 1, runner_reported_policy_checksum: "b".repeat(64), status: "applied", workspace_status: [] };
  return { type: "rpc.response", protocol_version: version, request_id: "rpc-outage", result: { private: "RESULT_MUST_NOT_BE_DELIVERED" } };
}
function socket(kind: string) {
  const close = vi.fn(), send = vi.fn();
  const ws = { close, send, serializeAttachment: vi.fn(), deserializeAttachment: () => ({ runnerId: runner, sessionId: "outage-session", epoch: kind === "hello" ? 0 : 1, credentialVersion: 1, lifecycleId: "a".repeat(64), protocolVersion: version, authenticated: true, helloDeadlineMs: Date.now() + 10000 }) } as unknown as WebSocket;
  return { ws, close, send };
}

const failures = [429, 500, 502, 503, 504].flatMap((status) => sessionFrames.map((kind) => ({ status, kind })));
it.each(failures)("uses retryable close 1013 for $kind with upstream $status", async ({ status, kind }) => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`outage-transport-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const request = vi.fn().mockResolvedValue(new Response("private upstream error", { status }));
    const replies = new BridgeReplies();
    const instance = new RunnerDO(state, env, { registryRequest: request, replies });
    const f = socket(kind);
    try {
      await instance.webSocketMessage(f.ws, encodeWireFrame(frame(kind)));
      expect(f.close).toHaveBeenCalledExactlyOnceWith(1013, "control plane temporarily unavailable");
      expect(f.send).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });
});

it.each(sessionFrames)("uses retryable close 4000 for a stale %s session", async (kind) => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`outage-revoke-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const request = vi.fn().mockResolvedValue(new Response("stale session", { status: 409 }));
    const replies = new BridgeReplies();
    const instance = new RunnerDO(state, env, { registryRequest: request, replies });
    const f = socket(kind);
    try {
      await instance.webSocketMessage(f.ws, encodeWireFrame(frame(kind)));
      expect(f.close).toHaveBeenCalledExactlyOnceWith(4000, "stale runner session");
      expect(f.send).not.toHaveBeenCalled();
    }
    finally { request.mockRestore(); }
  });
});

it.each([401, 403].flatMap((status) => sessionFrames.map((kind) => ({ status, kind }))))("retains fatal close 4001 for $kind with credential rejection $status", async ({ status, kind }) => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`credential-rejection-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const request = vi.fn().mockResolvedValue(new Response("private upstream response", { status }));
    const instance = new RunnerDO(state, env, { registryRequest: request, replies: new BridgeReplies() });
    const f = socket(kind);
    await instance.webSocketMessage(f.ws, encodeWireFrame(frame(kind)));
    expect(f.close).toHaveBeenCalledExactlyOnceWith(4001, "runner credentials rejected");
    expect(f.send).not.toHaveBeenCalled();
  });
});

it.each([401, 403, 409, 503])("preserves failure %s in the post-connect session fence before welcome", async (status) => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`post-connect-fence-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const request = vi.fn(async (_runnerId: string, action: string) => action === "/connect"
      ? Response.json({ epoch: 1, lifecycle_id: "a".repeat(64) }) : new Response("private fence response", { status }));
    const instance = new RunnerDO(state, env, { registryRequest: request, replies: new BridgeReplies() });
    const f = socket("hello");
    await instance.webSocketMessage(f.ws, encodeWireFrame(frame("hello")));
    expect(request.mock.calls.map((call) => call[1])).toEqual(["/connect", "/session"]);
    expect(f.close).toHaveBeenCalledExactlyOnceWith(status === 409 ? 4000 : status === 503 ? 1013 : 4001,
      status === 409 ? "stale runner session" : status === 503 ? "control plane temporarily unavailable" : "runner credentials rejected");
    expect(f.send).not.toHaveBeenCalled();
  });
});

it.each([429, 500, 502, 503, 504, 401, 403, 200])("does not turn an authentication dependency failure (%s) into a fake 401", async (status) => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`outage-upgrade-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const request = vi.fn().mockResolvedValue(new Response("malformed or unavailable", { status }));
    const replies = new BridgeReplies();
    const instance = new RunnerDO(state, env, { registryRequest: request, replies });
    try {
      const response = await instance.fetch(new Request(`https://runner.internal/runner/${runner}`, { headers: { Upgrade: "websocket", Authorization: "Bearer synthetic-runner-token" } }));
      expect(response.status).toBe(status === 401 || status === 403 ? 401 : status === 429 ? 429 : 503);
      expect(await response.text()).not.toContain("malformed or unavailable");
    } finally { request.mockRestore(); }
  });
});

it.each([undefined, 409, 401, 403])("rejects pending RPC replies when the session cannot be verified (%s)", async (status) => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`outage-reply-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const request = status === undefined ? vi.fn().mockRejectedValue(new Error("storage unavailable"))
      : vi.fn().mockResolvedValue(new Response("private session rejection", { status }));
    const replies = new BridgeReplies();
    const instance = new RunnerDO(state, env, { registryRequest: request, replies });
    const f = socket("session"), resolve = vi.fn();
    const timer = setTimeout(() => {}, 10000);
    replies.register("rpc-outage", { resolve, timer, socket: f.ws });
    try {
      await instance.webSocketMessage(f.ws, encodeWireFrame(frame("session")));
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(resolve.mock.calls)).not.toContain("RESULT_MUST_NOT_BE_DELIVERED");
      expect(resolve.mock.calls[0]?.[0].type).toBe("rpc.error");
      expect(f.close).toHaveBeenCalledWith(status === undefined ? 1013 : status === 409 ? 4000 : 4001,
        status === undefined ? "control plane temporarily unavailable" : status === 409 ? "stale runner session" : "runner credentials rejected");
    } finally { clearTimeout(timer); request.mockRestore(); }
  });
});
