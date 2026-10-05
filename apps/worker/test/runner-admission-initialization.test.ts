import { env, runInDurableObject, SELF } from "cloudflare:test";
import { decodeWireFrame, encodeWireFrame, PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";
import { RegistryDO } from "../src/index.js";
import { RunnerDO } from "../src/runner-do.js";
import { internalHeaders } from "../src/security.js";

it("does not let a delayed cold-start read erase a newly acquired mutation fence", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`admission-load-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const old = { fenced: true, reconciled: false, runnerId: null, activeRevision: null, activeChecksum: null,
      desiredRevision: null, desiredChecksum: null, connectionEpoch: null, credentialVersion: null, lifecycleId: null,
      sessionId: null, mutationId: null, mutationPhase: "restart_reconcile", preMutationActiveRevision: null,
      preMutationActiveChecksum: null, preMutationDesiredRevision: null, preMutationDesiredChecksum: null, lastReconciledAtMs: null };
    const reads: Array<(value: unknown) => void> = [];
    const storage = new Proxy(state.storage, { get(target, key) {
      if (key === "get") return () => new Promise<unknown>(resolve => { reads.push(resolve); });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const port = new Proxy(state, { get(target, key) {
      if (key === "storage") return storage;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const instance = new RunnerDO(port, env) as unknown as {
      admission(): Promise<{ fenced: boolean; mutationId: string | null; mutationPhase: string }>;
      beginPolicyMutation(id: string, runnerId: string): Promise<string>;
    };
    const first = instance.admission(), delayed = instance.admission();
    expect(reads).toHaveLength(2);
    reads[0]!(old);
    await first;
    expect(await instance.beginPolicyMutation("new-mutation", "new-runner")).toBe("started");
    reads[1]!(old);
    await delayed;
    expect(await instance.admission()).toMatchObject({ fenced: true, mutationId: "new-mutation", mutationPhase: "precommit" });
    expect(await state.storage.get("policy-admission-v1")).toMatchObject({ mutationId: "new-mutation", mutationPhase: "precommit" });
  });
});

it.each(["before hello", "during connect"])("preserves an owned mutation fence on first connection (%s)", async timing => {
  const runnerId = `first-hello-${crypto.randomUUID()}`;
  const token = "abcdef0123456789abcdef0123456789";
  const mutationId = "pending-admin-mutation";
  const registered = await SELF.fetch("https://worker.test/admin/runners", {
    method: "POST", headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ runner_id: runnerId, token, execution_mode: "dedicated_user" }),
  });
  expect(registered.status).toBe(200);
  await registered.body?.cancel();
  const request = async (path: string, input?: Record<string, unknown>) => {
    const method = input === undefined ? "GET" : "POST";
    const body = input === undefined ? "" : JSON.stringify(input);
    return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request(`https://runner.internal${path}`, {
      method, headers: await internalHeaders(env.INTERNAL_CONTROL_SECRET, method, path, body),
      ...(input === undefined ? {} : { body }),
    }));
  };
  const acquire = async () => {
    expect((await request("/begin-policy-mutation", { runner_id: runnerId, mutation_id: mutationId })).status).toBe(204);
    expect(await (await request("/admission-state")).json()).toMatchObject({
      mutationId, mutationPhase: "precommit", lifecycleId: null, credentialVersion: null, connectionEpoch: null, sessionId: null,
    });
  };
  if (timing === "before hello") await acquire();
  const original = RegistryDO.prototype.fetch;
  let intercepted = false;
  const spy = timing === "during connect" ? vi.spyOn(RegistryDO.prototype, "fetch").mockImplementation(async function (this: RegistryDO, incoming: Request) {
    const response = await original.call(this, incoming);
    if (!intercepted && incoming.method === "POST" && new URL(incoming.url).pathname === `/runners/${runnerId}/connect` && response.ok) {
      intercepted = true;
      await acquire();
    }
    return response;
  }) : undefined;
  let socket: WebSocket | null = null;
  try {
    const upgraded = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${runnerId}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
    });
    expect(upgraded.status).toBe(101);
    socket = upgraded.webSocket;
    expect(socket).not.toBeNull();
    socket!.accept();
    const welcome = new Promise<string>(resolve => socket!.addEventListener("message", event => resolve(String(event.data)), { once: true }));
    socket!.send(encodeWireFrame({
      type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello",
      min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
      runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: {
        filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false,
        max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {},
      } },
    }));
    expect(decodeWireFrame(await welcome).type).toBe("runner.welcome");
    if (timing === "during connect") expect(intercepted).toBe(true);
    expect(await (await request("/admission-state")).json()).toMatchObject({
      runnerId, mutationId, mutationPhase: "precommit", fenced: true, reconciled: false,
      lifecycleId: expect.any(String), credentialVersion: expect.any(Number), connectionEpoch: expect.any(Number), sessionId: expect.any(String),
    });
    expect((await request("/begin-policy-mutation", { runner_id: runnerId, mutation_id: "competing-mutation" })).status).toBe(409);
    expect((await request("/cancel-policy-mutation", { mutation_id: mutationId })).status).toBe(204);
    expect(await (await request("/admission-state")).json()).toMatchObject({
      fenced: true, reconciled: false, mutationId: "restart-reconcile", mutationPhase: "restart_reconcile",
    });
  } finally { socket?.close(); spy?.mockRestore(); }
});
