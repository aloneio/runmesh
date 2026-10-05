import { env, SELF, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { decodeWireFrame, encodeWireFrame, PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { RegistryDO } from "../src/registry.js";

const oldToken = "old-token-0123456789abcdef0123456789";
const newToken = "new-token-0123456789abcdef0123456789";
function hello(runnerId: string): string {
  return encodeWireFrame({ type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "auth-lifecycle-hello",
    min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
    runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: {
      filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false,
      max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {},
    } },
  });
}
function handshake(socket: WebSocket, runnerId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("handshake did not settle")), 2_000);
    const complete = (value: string) => { clearTimeout(timer); resolve(value); };
    socket.addEventListener("message", event => complete(decodeWireFrame(String(event.data)).type), { once: true });
    socket.addEventListener("close", event => complete(`close:${event.code}`), { once: true });
    socket.send(hello(runnerId));
  });
}

it("keeps delayed authentication bound to the deleted Runner lifecycle", async () => {
  const runnerId = `auth-lifecycle-${crypto.randomUUID()}`;
  const admin = (path: string, input: object) => SELF.fetch(`https://worker.test/admin/runners${path}`, {
    method: "POST", headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const connect = (token: string) => SELF.fetch(`https://worker.test/runner/connect?runner_id=${runnerId}`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
  });
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
  const state = () => runInDurableObject(registry, instance => instance.getRunnerExecutionState(runnerId));
  expect((await admin("", { runner_id: runnerId, token: oldToken, execution_mode: "dedicated_user" })).status).toBe(200);
  const before = await state();
  const original = RegistryDO.prototype.fetch;
  let intercepted = false;
  const spy = vi.spyOn(RegistryDO.prototype, "fetch").mockImplementation(async function (this: RegistryDO, request: Request) {
    const response = await original.call(this, request);
    if (!intercepted && new URL(request.url).pathname === `/runners/${runnerId}/auth` && response.ok) {
      intercepted = true;
      expect((await admin(`/${runnerId}/delete`, { confirmation: runnerId })).status).toBe(204);
      expect((await admin("", { runner_id: runnerId, token: newToken, execution_mode: "dedicated_user" })).status).toBe(200);
    }
    return response;
  });
  const sockets: WebSocket[] = [];
  try {
    const upgrade = await connect(oldToken);
    expect(intercepted).toBe(true); expect(upgrade.status).toBe(101);
    const recreated = await state();
    expect(recreated!.lifecycle_id).not.toBe(before!.lifecycle_id);
    expect(recreated!.runner.credential_version).toBe(before!.runner.credential_version);
    expect((await connect(oldToken)).status).toBe(401);
    const stale = upgrade.webSocket!; sockets.push(stale); stale.accept();
    expect(await handshake(stale, runnerId)).toBe("close:4000");
    expect(await state()).toEqual(recreated);
    const replacement = await connect(newToken);
    expect(replacement.status).toBe(101);
    const current = replacement.webSocket!; sockets.push(current); current.accept();
    expect(await handshake(current, runnerId)).toBe("runner.welcome");
    expect(await state()).toMatchObject({ lifecycle_id: recreated!.lifecycle_id, runner: { state: "online" } });
  } finally { sockets.forEach(socket => socket.close()); spy.mockRestore(); }
});

it.each([undefined, null, "short", "x".repeat(129)])("rejects an invalid authenticated lifecycle before upgrading: %s", async lifecycleId => {
  const runnerId = `invalid-auth-${crypto.randomUUID()}`, original = RegistryDO.prototype.fetch;
  const spy = vi.spyOn(RegistryDO.prototype, "fetch").mockImplementation(function (this: RegistryDO, request: Request) {
    return new URL(request.url).pathname === `/runners/${runnerId}/auth`
      ? Promise.resolve(Response.json({ credential_version: 1, lifecycle_id: lifecycleId })) : original.call(this, request);
  });
  try {
    const response = await SELF.fetch(`https://worker.test/runner/connect?runner_id=${runnerId}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${oldToken}` },
    });
    expect(response.status).toBe(503); expect(response.webSocket).toBeNull();
  } finally { spy.mockRestore(); }
});
