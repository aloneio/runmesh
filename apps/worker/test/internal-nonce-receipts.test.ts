import { env, runInDurableObject } from "cloudflare:test";
import { decodeWireFrame, encodeWireFrame, PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";
import { consumeInternalNonce } from "../src/platform/control-plane.js";
import { BridgeReplies } from "../src/platform/bridge-replies.js";
import { RunnerDO } from "../src/runner-do.js";
import { internalHeaders } from "../src/security.js";

function nonceEnvironment(response: () => Response) {
  return { ...env, REGISTRY: { idFromName: () => "registry", get: () => ({ fetch: response }) } } as unknown as typeof env;
}

async function rpcRequest() {
  const body = JSON.stringify({ method: "echo", params: {} });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET!, "POST", "/rpc", body);
  return new Request("https://runner.internal/rpc", { method: "POST", headers, body });
}

it.each([200, 202, 204, 404, 409, 429, 503])("only a completed nonce receipt grants consumption at HTTP %s and releases its body", async status => {
  const cancel = vi.fn();
  const localEnv = nonceEnvironment(() => new Response(status === 204 ? null : new ReadableStream({ cancel }), { status }));
  expect(await consumeInternalNonce(localEnv, "a".repeat(64), Date.now() + 60_000)).toBe(status === 204);
  expect(cancel).toHaveBeenCalledTimes(status === 204 ? 0 : 1);
});

it.each([200, 202, 404, 409, 429, 503])("RunnerDO classifies nonce HTTP %s before any Runner lookup and releases its body", async status => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`nonce-receipt-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const cancel = vi.fn(), sockets = vi.fn(() => []);
    const localEnv = nonceEnvironment(() => new Response(new ReadableStream({ cancel }), { status }));
    const statePort = new Proxy(state, { get(target, key) {
      if (key === "getWebSockets") return sockets;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const response = await new RunnerDO(statePort, localEnv).fetch(await rpcRequest());
    try {
      expect(response.status).toBe(status === 404 || status === 409 ? 404 : 503);
      expect(cancel).toHaveBeenCalledOnce();
      expect(sockets).not.toHaveBeenCalled();
    } finally { await response.body?.cancel(); }
  });
});

it.each(["pending", "rejected"] as const)("nonce cleanup that is %s cannot block or replace a rejection", async cleanup => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const cancel = vi.fn(() => cleanup === "pending" ? gate : Promise.reject(new Error("cleanup unavailable")));
  const localEnv = nonceEnvironment(() => new Response(new ReadableStream({ cancel }), { status: 404 }));
  try {
    expect(await consumeInternalNonce(localEnv, "a".repeat(64), Date.now() + 60_000)).toBe(false);
    const stub = env.RUNNER.get(env.RUNNER.idFromName(`nonce-cleanup-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_existing, state) => {
      const response = await new RunnerDO(state, localEnv).fetch(await rpcRequest());
      try { expect(response.status).toBe(404); }
      finally { await response.body?.cancel(); }
    });
    expect(cancel).toHaveBeenCalledTimes(2);
  } finally { release(); }
}, 2_000);

it("consumes the original nonce through Registry and rejects a replay before a second RPC dispatch", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`nonce-replay-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const replies = new BridgeReplies();
    let attachment: unknown = { runnerId: "nonce-runner", sessionId: "nonce-session", epoch: 0, credentialVersion: 1, lifecycleId: null,
      protocolVersion: 0, authenticated: true, helloDeadlineMs: Date.now() + 10_000 };
    const send = vi.fn((raw: string) => {
      const frame = decodeWireFrame(raw);
      if (frame.type === "rpc.request") replies.deliver(ws, { type: "rpc.response", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: frame.request_id, result: {} });
    });
    const ws = { send, close: vi.fn(), deserializeAttachment: () => attachment, serializeAttachment: (value: unknown) => { attachment = value; } } as unknown as WebSocket;
    const statePort = new Proxy(state, { get(target, key) {
      if (key === "getWebSockets") return () => [ws];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const registryRequest = async (_runner: string, action: string) => {
      if (action === "/connect") return Response.json({ epoch: 1, lifecycle_id: "a".repeat(64) });
      if (action === "/session") return new Response(null, { status: 204 });
      throw new Error(`Unexpected test route: ${action}`);
    };
    const instance = new RunnerDO(statePort, env, { registryRequest, replies });
    await instance.webSocketMessage(ws, encodeWireFrame({ type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION,
      request_id: "nonce-hello", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
      runner: { runner_id: "nonce-runner", runner_version: "test", platform: "test", architecture: "test", capabilities: {
        filesystem: true, process_execution: true, workspace_sync: true, pty: false, network_access: false,
        max_concurrent_jobs: 2, supported_rpc_methods: [], labels: {} } } }));
    expect(send).toHaveBeenCalledOnce();
    send.mockClear();
    const original = await rpcRequest(), replay = original.clone();
    const first = await instance.fetch(original);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ type: "rpc.response" });
    expect(send).toHaveBeenCalledOnce();
    const second = await instance.fetch(replay);
    expect(second.status).toBe(404);
    expect(await second.text()).toBe("not found");
    expect(send).toHaveBeenCalledOnce();
    expect(replies.size).toBe(0);
  });
});
