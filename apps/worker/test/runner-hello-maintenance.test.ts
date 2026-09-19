import { env, runInDurableObject } from "cloudflare:test";
import { encodeWireFrame, PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";
import { RunnerDO } from "../src/runner-do.js";

function pendingSocket(deadline = Date.now() + 10_000) {
  let attachment: unknown = { runnerId: "hello-runner", sessionId: crypto.randomUUID(), epoch: 0, credentialVersion: 1,
    lifecycleId: null, protocolVersion: 0, authenticated: true, helloDeadlineMs: deadline };
  let readyState = WebSocket.OPEN;
  return {
    get readyState() { return readyState; },
    send: vi.fn(), close: vi.fn(() => { readyState = WebSocket.CLOSING; }),
    deserializeAttachment: () => attachment,
    serializeAttachment: (value: unknown) => { attachment = value; },
  } as unknown as WebSocket;
}

const hello = encodeWireFrame({ type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello",
  min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
  runner: { runner_id: "hello-runner", runner_version: "test", platform: "test", architecture: "test", capabilities: {
    filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false,
    max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } } });

it.each([false, true])("clears the completed hello deadline and preserves another pending handshake: %s", async anotherPending => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`hello-deadline-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const first = pendingSocket(), remainingDeadline = Date.now() + 15_000;
    const sockets = anotherPending ? [first, pendingSocket(remainingDeadline)] : [first];
    const port = new Proxy(state, { get(target, key) {
      if (key === "getWebSockets") return () => sockets;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const instance = new RunnerDO(port, env, { registryRequest: async (_id, action) => {
      if (action === "/connect") return Response.json({ epoch: 1, lifecycle_id: "a".repeat(64) });
      if (action === "/session") return new Response(null, { status: 204 });
      throw new Error(`unexpected ${action}`);
    } });
    // The accepted socket installed this deadline before sending hello.
    await state.storage.setAlarm(Date.now() + 10_000);
    await instance.webSocketMessage(first, hello);
    expect(first.send).toHaveBeenCalledOnce();
    expect(await state.storage.getAlarm()).toBe(anotherPending ? remainingDeadline : null);
  });
});

it("does not rearm an expired alarm while the timed-out socket is still closing", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`hello-expired-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const expired = pendingSocket(Date.now() - 1);
    const port = new Proxy(state, { get(target, key) {
      if (key === "getWebSockets") return () => [expired];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const instance = new RunnerDO(port, env);
    await state.storage.setAlarm(Date.now() + 1_000);
    await instance.alarm();
    expect(expired.close).toHaveBeenCalledWith(1008, "hello timeout");
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it("keeps a completed handshake connected when optional alarm cleanup fails", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`hello-cleanup-failure-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const socket = pendingSocket();
    const port = new Proxy(state, { get(target, key) {
      if (key === "getWebSockets") return () => [socket];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const instance = new RunnerDO(port, env, { registryRequest: async (_id, action) => {
      if (action === "/connect") return Response.json({ epoch: 1, lifecycle_id: "a".repeat(64) });
      if (action === "/session") return new Response(null, { status: 204 });
      throw new Error(`unexpected ${action}`);
    } });
    const cleanup = vi.spyOn(state.storage, "deleteAlarm").mockRejectedValueOnce(new Error("optional alarm storage unavailable"));
    try {
      await instance.webSocketMessage(socket, hello);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(socket.send).toHaveBeenCalledOnce();
      expect(socket.close).not.toHaveBeenCalled();
      expect(await state.storage.get("policy-admission-v1")).toMatchObject({ connectionEpoch: 1, sessionId: expect.any(String) });
    } finally { cleanup.mockRestore(); }
  });
});
