import { RunnerDO } from "../src/runner-do.js";
import { BridgeReplies } from "../src/platform/bridge-replies.js";
import { internalHeaders } from "../src/security.js";
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

it.each(sessionFrames)("releases the discarded Registry response when a %s frame fails", async kind => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`discarded-frame-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const cancel = vi.fn();
    const receipt = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 });
    const request = vi.fn(async () => receipt);
    const instance = new RunnerDO(state, env, { registryRequest: request });
    const f = socket(kind);
    await instance.webSocketMessage(f.ws, encodeWireFrame(frame(kind)));
    expect(f.close).toHaveBeenCalledExactlyOnceWith(1013, "control plane temporarily unavailable");
    expect(f.send).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

it.each([403, 429, 503])("releases discarded HTTP %s authentication receipts without changing the result", async status => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`discarded-auth-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const cancel = vi.fn();
    const receipt = new Response(new ReadableStream<Uint8Array>({ cancel }), { status, headers: { "retry-after": "73" } });
    const request = vi.fn(async () => receipt);
    const instance = new RunnerDO(state, env, { registryRequest: request });
    const response = await instance.fetch(new Request(`https://runner.internal/runner/${runner}`, { headers: { Upgrade: "websocket", Authorization: "Bearer synthetic-runner-token" } }));
    try {
      expect(response.status).toBe(status === 403 ? 401 : status);
      if (status !== 403) expect(response.headers.get("retry-after")).toBe("73");
      expect(request).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    } finally { await response.body?.cancel(); }
  });
});

it("releases the status-only disconnect receipt", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`discarded-disconnect-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const cancel = vi.fn(), request = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 }));
    const instance = new RunnerDO(state, env, { registryRequest: request });
    await instance.webSocketClose(socket("session").ws);
    expect(request.mock.calls).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

it.each(["pending", "rejected"] as const)("keeps the original frame failure when receipt cleanup is %s", async cleanup => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`discarded-cleanup-${crypto.randomUUID()}`));
  try {
    await runInDurableObject(stub, async (_existing, state) => {
      const cancel = vi.fn(() => cleanup === "pending" ? pending : Promise.reject(new Error("cleanup unavailable")));
      const request = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 }));
      const instance = new RunnerDO(state, env, { registryRequest: request });
      const f = socket("heartbeat");
      await instance.webSocketMessage(f.ws, encodeWireFrame(frame("heartbeat")));
      expect(f.close).toHaveBeenCalledExactlyOnceWith(1013, "control plane temporarily unavailable");
      expect(request).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    });
  } finally { release(); }
}, 2_000);

it.each(["heartbeat", "event", "sync"])("releases a status-only successful %s receipt", async kind => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`discarded-success-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const cancel = vi.fn(), request = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    const instance = new RunnerDO(state, env, { registryRequest: request });
    const f = socket(kind);
    await instance.webSocketMessage(f.ws, encodeWireFrame(frame(kind)));
    expect(f.close).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

async function internalRequest(instance: RunnerDO, path: string, value?: Record<string, unknown>) {
  const method = value === undefined ? "GET" : "POST";
  const body = value === undefined ? "" : JSON.stringify(value);
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET!, method, path, body);
  return instance.fetch(new Request(`https://runner.internal${path}`, { method, headers, ...(value === undefined ? {} : { body }) }));
}

it.each([
  { path: "/mark-policy-committed", action: "/desired-policy", status: 503, code: "policy_commit_unverified" },
  { path: "/cancel-policy-mutation", action: "/mutation-state?mutation_id=original", status: 503, code: "registry_unavailable" },
  { path: "/begin-policy-mutation", action: "/mutation-state?mutation_id=original", status: 409, code: "mutation_in_progress" },
  { path: "/revoke", action: "/mutation-state?mutation_id=original", status: 409, code: "mutation_uncommitted" },
])("releases $action failures during $path and retains the original mutation", async ({ path, action, status, code }) => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`discarded-mutation-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const cancel = vi.fn(), registryRequest = vi.fn(async (_id: string, _action: string) => new Response(new ReadableStream({ cancel }), { status: 503 }));
    const instance = new RunnerDO(state, env, { registryRequest });
    expect((await internalRequest(instance, "/begin-policy-mutation", { mutation_id: "original", runner_id: runner })).status).toBe(204);
    const response = await internalRequest(instance, path, {
      mutation_id: path === "/begin-policy-mutation" ? "replacement" : "original", runner_id: runner,
      desired_revision: 1, desired_checksum: "b".repeat(64), phase: "offline_pending",
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(registryRequest).toHaveBeenCalledOnce();
    expect(registryRequest.mock.calls[0]?.[1]).toBe(action);
    expect(cancel).toHaveBeenCalledOnce();
    const admission = await internalRequest(instance, "/admission-state");
    expect(await admission.json()).toMatchObject({ fenced: true, mutationId: "original", mutationPhase: "precommit" });
  });
});

it.each(["/policy-readiness", "/active-policy"])("releases %s failure during policy acknowledgment reconciliation", async action => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`discarded-policy-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const cancel = vi.fn();
    const registryRequest = vi.fn(async (_id: string, route: string) => {
      if (route === action) return new Response(new ReadableStream({ cancel }), { status: 503 });
      if (route === "/policy-ack") return Response.json({ ack_result: "applied" });
      if (route === "/policy-readiness") return Response.json({ ok: true, policy_status: "applied", desired_revision: 1, applied_revision: 1,
        runner_reported_policy_revision: 1, desired_checksum: "b".repeat(64), active_checksum: "b".repeat(64),
        runner_reported_policy_checksum: "b".repeat(64), connection_epoch: 1, credential_version: 1,
        session_id: "outage-session", lifecycle_id: "a".repeat(64) });
      throw new Error(`Unexpected test route: ${route}`);
    });
    const instance = new RunnerDO(state, env, { registryRequest });
    const f = socket("policy");
    await instance.webSocketMessage(f.ws, encodeWireFrame(frame("policy")));
    expect(f.close).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(registryRequest.mock.calls.at(-1)?.[1]).toBe(action);
    const admission = await internalRequest(instance, "/admission-state");
    expect(await admission.json()).toMatchObject({ fenced: true, reconciled: false, activeRevision: null });
  });
});

it("releases a failed current-session receipt before returning a structured RPC error", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`discarded-current-session-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    let attachment: unknown = socket("hello").ws.deserializeAttachment();
    const ws = { close: vi.fn(), send: vi.fn(), readyState: WebSocket.OPEN,
      deserializeAttachment: () => attachment, serializeAttachment: (value: unknown) => { attachment = value; } } as unknown as WebSocket;
    const statePort = new Proxy(state, { get(target, key) {
      if (key === "getWebSockets") return () => [ws];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    let connected = false;
    const cancel = vi.fn();
    const registryRequest = vi.fn(async (_id: string, action: string) => {
      if (action === "/connect") return Response.json({ epoch: 1, lifecycle_id: "a".repeat(64) });
      if (action === "/session") return connected ? new Response(new ReadableStream({ cancel }), { status: 503 }) : new Response(null, { status: 204 });
      throw new Error(`Unexpected test route: ${action}`);
    });
    const instance = new RunnerDO(statePort, env, { registryRequest });
    await instance.webSocketMessage(ws, encodeWireFrame(frame("hello")));
    expect(ws.send).toHaveBeenCalledOnce();
    expect(ws.close).not.toHaveBeenCalled();
    connected = true;
    const response = await internalRequest(instance, "/rpc", { method: "echo", params: {} });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "control_plane_unavailable" } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(ws.send).toHaveBeenCalledOnce();
  });
});

it.each([401, 403, 409])("releases rejected policy receipt %s before a failed admission write reaches the outer catch", async status => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`discarded-policy-write-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    let attachment: unknown = socket("hello").ws.deserializeAttachment();
    const ws = { close: vi.fn(), send: vi.fn(), readyState: WebSocket.OPEN,
      deserializeAttachment: () => attachment, serializeAttachment: (value: unknown) => { attachment = value; } } as unknown as WebSocket;
    const events: string[] = [], cancel = vi.fn(() => { events.push("cancel"); });
    const registryRequest = vi.fn(async (_id: string, action: string) => {
      if (action === "/connect") return Response.json({ epoch: 1, lifecycle_id: "a".repeat(64) });
      if (action === "/session") return new Response(null, { status: 204 });
      if (action === "/policy-ack") return new Response(new ReadableStream({ cancel }), { status });
      throw new Error(`Unexpected test route: ${action}`);
    });
    const replies = new BridgeReplies(), instance = new RunnerDO(state, env, { registryRequest, replies });
    await instance.webSocketMessage(ws, encodeWireFrame(frame("hello")));
    expect(ws.send).toHaveBeenCalledOnce();
    expect(ws.close).not.toHaveBeenCalled();
    expect((await internalRequest(instance, "/begin-policy-mutation", { mutation_id: "policy-write", runner_id: runner })).status).toBe(204);
    const resolve = vi.fn(), timer = setTimeout(() => {}, 10_000);
    replies.register("pending-policy-rpc", { resolve, timer, socket: ws });
    const put = vi.spyOn(state.storage, "put");
    try {
      put.mockImplementationOnce(async () => { events.push("write"); throw new Error("synthetic admission storage failure"); });
      await instance.webSocketMessage(ws, encodeWireFrame(frame("policy")));
      expect(put).toHaveBeenCalledOnce();
      expect(ws.close).toHaveBeenCalledExactlyOnceWith(1013, "control plane temporarily unavailable");
      expect(ws.send).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve.mock.calls[0]?.[0]).toMatchObject({ type: "rpc.error" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(events).toEqual(["cancel", "write"]);
      const admission = await internalRequest(instance, "/admission-state");
      expect(await admission.json()).toMatchObject({ fenced: true, reconciled: false, mutationId: "policy-write", mutationPhase: "invalid" });
    } finally { clearTimeout(timer); put.mockRestore(); }
  });
});
