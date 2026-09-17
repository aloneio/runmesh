import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { decodeWireFrame, encodeWireFrame, PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { RunnerDO } from "../src/runner-do.js";
import { BridgeReplies } from "../src/platform/bridge-replies.js";
import { internalHeaders } from "../src/security.js";

async function harness(access: () => Response, run: (instance: RunnerDO, replies: BridgeReplies, ws: WebSocket, send: ReturnType<typeof vi.fn>, authorize: () => void) => Promise<void>, authorization: () => Response = () => Response.json({ ok: true })) {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`admission-errors-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const replies = new BridgeReplies();
    let attachment: unknown = { runnerId: "runner-test", sessionId: "session-test", epoch: 0, credentialVersion: 1, lifecycleId: null,
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
    let onAuthorize = () => {};
    const request = async (_runner: string, action: string) => {
      if (action === "/connect") return Response.json({ epoch: 1, lifecycle_id: "a".repeat(64) });
      if (action === "/session") return new Response(null, { status: 204 });
      if (action === "/access") return access();
      if (action === "/mcp-authorization") { onAuthorize(); return authorization(); }
      throw new Error(`Unexpected test route: ${action}`);
    };
    const instance = new RunnerDO(statePort, env, { registryRequest: request, replies });
    await instance.webSocketMessage(ws, encodeWireFrame({ type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION,
      request_id: "hello-test", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
      runner: { runner_id: "runner-test", runner_version: "test", platform: "test", architecture: "test", capabilities: {
        filesystem: true, process_execution: true, workspace_sync: true, pty: false, network_access: false,
        max_concurrent_jobs: 2, supported_rpc_methods: [], labels: {} } } }));
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear();
    const timers: ReturnType<typeof setTimeout>[] = [];
    try {
      await run(instance, replies, ws, send, () => {
        onAuthorize = () => {
          for (let index = 0; index < 32; index++) {
            const timer = setTimeout(() => {}, 30_000); timers.push(timer);
            replies.register(`other-${index}`, { resolve: () => {}, socket: ws, timer });
          }
        };
      });
    } finally { for (const timer of timers) clearTimeout(timer); }
  });
}
async function request(instance: RunnerDO, method = "fs.read", authorize = false) {
  const body = JSON.stringify({ method, params: { workspace_id: "work", path: "file" },
    ...(authorize ? { mcp_authorization: { client_id: "client-test", secret_version: 1 } } : {}) });
  const headers = await internalHeaders("test-internal-control-secret-not-for-production", "POST", "/rpc", body);
  return instance.fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body }));
}

it.each([429, 500, 502, 503, 504])("keeps an access dependency HTTP %s failure retryable, not an authorization rejection", async status => {
  await harness(() => Response.json({ allowed: false, status: "expired" }, { status }), async (instance, _replies, _ws, send) => {
    const response = await request(instance);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "runner_access_unavailable", failure_class: "availability", operation_state: "not_started", next_action: "wait_and_retry" } });
    expect(send).not.toHaveBeenCalled();
  });
});
it.each([null, [], {}, { allowed: "false" }])("rejects malformed access decisions without fabricating denied credentials: %j", async value => {
  await harness(() => Response.json(value), async (instance, _replies, _ws, send) => {
    expect(await (await request(instance)).json()).toMatchObject({ error: { code: "runner_access_unavailable", operation_state: "not_started" } });
    expect(send).not.toHaveBeenCalled();
  });
});
it.each([{ status: "scheduled", code: "runner_not_active" }, { status: "expired", code: "runner_expired" }])("retains explicit access rejection $code", async ({ status, code }) => {
  await harness(() => Response.json({ allowed: false, status }), async (instance, _replies, _ws, send) => {
    const response = await request(instance);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code, failure_class: "authorization", operation_state: "not_started" } });
    expect(send).not.toHaveBeenCalled();
  });
});
it("rechecks concurrent capacity after asynchronous authorization and before reserving a callback", async () => {
  await harness(() => Response.json({ allowed: true }), async (instance, replies, _ws, send, saturate) => {
    saturate();
    const response = await request(instance, "echo", true);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "busy", operation_state: "not_started", retry_after_ms: 1000 } });
    expect(replies.size).toBe(32);
    expect(send).not.toHaveBeenCalled();
  });
});
it("drops callbacks after a timeout removal and ignores duplicate replies", () => {
  const replies = new BridgeReplies(), resolve = vi.fn(), ws = {} as WebSocket;
  const timer = setTimeout(() => {}, 10_000);
  try {
    replies.register("original", { resolve, socket: ws, timer });
    replies.forget("original");
    const frame = { type: "rpc.response" as const, protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "original", result: {} };
    replies.deliver(ws, frame); replies.deliver(ws, frame);
    expect(resolve).not.toHaveBeenCalled();
    expect(replies.size).toBe(0);
  } finally { clearTimeout(timer); }
});


it.each([201, 202, 203, 206, 207, 403, 409])("does not admit an incomplete access decision carried by HTTP %s", async status => {
  await harness(() => Response.json({ allowed: true }, { status }), async (instance, _replies, _ws, send) => {
    const response = await request(instance);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "runner_access_unavailable", operation_state: "not_started" } });
    expect(send).not.toHaveBeenCalled();
  });
});
it.each([201, 202, 203, 206, 207, 403, 409])("does not dispatch after a final authorization grant carried by HTTP %s", async status => {
  await harness(() => Response.json({ allowed: true }), async (instance, _replies, _ws, send) => {
    const response = await request(instance, "echo", true);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "control_plane_unavailable", operation_state: "not_started" } });
    expect(send).not.toHaveBeenCalled();
  }, () => Response.json({ ok: true }, { status }));
});
it.each([200, 403, 409])("preserves an explicit final authorization rejection at HTTP %s", async status => {
  await harness(() => Response.json({ allowed: true }), async (instance, _replies, _ws, send) => {
    const response = await request(instance, "echo", true);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "permission_denied", operation_state: "not_started" } });
    expect(send).not.toHaveBeenCalled();
  }, () => Response.json({ ok: false }, { status }));
});
it("rejects an oversized final authorization receipt without dispatch", async () => {
  await harness(() => Response.json({ allowed: true }), async (instance, _replies, _ws, send) => {
    const response = await request(instance, "echo", true);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "control_plane_unavailable", operation_state: "not_started" } });
    expect(send).not.toHaveBeenCalled();
  }, () => Response.json({ ok: true, padding: "x".repeat(16_384) }));
});
