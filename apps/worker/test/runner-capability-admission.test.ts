import { env, runInDurableObject } from "cloudflare:test";
import { decodeWireFrame, encodeWireFrame, runnerPolicyChecksum } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";
import { RunnerDO } from "../src/runner-do.js";
import { BridgeReplies } from "../src/platform/bridge-replies.js";
import { internalHeaders } from "../src/security.js";

const extensions = ["context.storage", "context.prune"] as const;
const policyInput = { schema_version: 1 as const, runner_id: "compat-runner", revision: 1,
  runner_permissions: { read: true, edit: true, shell: true, job_control: true }, workspaces: [] };
const policy = { ...policyInput, checksum: runnerPolicyChecksum(policyInput) };

async function fixture(methods: string[], run: (request: (method: string) => Promise<Response>, socket: WebSocket,
  sent: string[], restart: (legacyAttachment?: boolean) => void, deny: () => void) => Promise<void>) {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`compat-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const replies = new BridgeReplies(), sent: string[] = [];
    let allowed = true;
    let attachment: Record<string, unknown> = { runnerId: policy.runner_id, sessionId: "compat-session", epoch: 0,
      credentialVersion: 1, lifecycleId: null, protocolVersion: 0, authenticated: true, helloDeadlineMs: Date.now() + 10_000 };
    const socket = { readyState: WebSocket.OPEN, close: vi.fn(),
      deserializeAttachment: () => attachment, serializeAttachment: (value: Record<string, unknown>) => { attachment = value; },
      send(raw: string) {
        const message = decodeWireFrame(raw);
        if (message.type !== "rpc.request") return;
        sent.push(message.method);
        // Stable 0.1.3 has a strict method enum that predates these methods.
        if (extensions.some(method => method === message.method) && !methods.includes(message.method)) {
          socket.close(1008, "invalid protocol message");
          throw new Error("legacy method enum rejected the request");
        }
        replies.deliver(socket, { type: "rpc.response", protocol_version: 2, request_id: message.request_id, result: {} });
      },
    } as unknown as WebSocket;
    const port = new Proxy(state, { get(target, key) {
      if (key === "getWebSockets") return () => [socket];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const registryRequest = async (_id: string, action: string) => {
      if (action === "/connect") return Response.json({ epoch: 1, lifecycle_id: "a".repeat(64) });
      if (action === "/session") return new Response(null, { status: 204 });
      if (action === "/access") return Response.json({ allowed: true });
      if (action === "/mcp-authorization") return Response.json({ ok: allowed });
      if (action === "/active-policy") return Response.json(policy);
      if (action === "/policy-readiness") return Response.json({ ok: true, policy_status: "applied",
        desired_revision: 1, applied_revision: 1, runner_reported_policy_revision: 1,
        desired_checksum: policy.checksum, active_checksum: policy.checksum, runner_reported_policy_checksum: policy.checksum,
        connection_epoch: 1, credential_version: 1, session_id: "compat-session", lifecycle_id: "a".repeat(64) });
      throw new Error(`unexpected route ${action}`);
    };
    let instance = new RunnerDO(port, env, { registryRequest, replies });
    await instance.webSocketMessage(socket, encodeWireFrame({ type: "runner.hello", protocol_version: 2, request_id: "hello",
      min_protocol_version: 2, max_protocol_version: 2,
      runner: { runner_id: policy.runner_id, runner_version: "999.0.0", platform: "test", architecture: "test", capabilities: {
        filesystem: true, process_execution: true, workspace_sync: true, pty: false, network_access: false,
        max_concurrent_jobs: 2, supported_rpc_methods: methods, labels: {} } } }));
    expect(socket.close).not.toHaveBeenCalled();
    await run(async method => {
      const body = JSON.stringify({ method, params: { workspace_id: "work" }, policy_revision: 1,
        expected_policy_revision: 1, expected_policy_checksum: policy.checksum,
        mcp_authorization: { client_id: "client", secret_version: 1 } });
      const headers = await internalHeaders("test-internal-control-secret-not-for-production", "POST", "/rpc", body);
      return instance.fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body }));
    }, socket, sent, legacyAttachment => {
      if (legacyAttachment) delete attachment.contextMethods;
      instance = new RunnerDO(port, env, { registryRequest, replies });
    }, () => { allowed = false; });
  });
}

it.each(extensions)("does not disconnect an older Runner for unadvertised %s", async method => {
  await fixture(["fs.read", "context.read"], async (request, socket, sent) => {
    const response = await request(method);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "runner_upgrade_required", operation_state: "not_started" } });
    expect(sent).toEqual([]); expect(socket.close).not.toHaveBeenCalled();
    expect((await request("context.read")).status).toBe(200);
    expect(sent).toEqual(["context.read"]);
  });
});

it.each(extensions)("retains advertised %s across Durable Object re-instantiation", async method => {
  await fixture([method], async (request, socket, sent, restart) => {
    restart();
    expect((await request(method)).status).toBe(200);
    expect(sent).toEqual([method]); expect(socket.close).not.toHaveBeenCalled();
    const other = extensions.find(value => value !== method)!;
    expect((await request(other)).status).toBe(409);
    expect(sent).toEqual([method]);
  });
});

it("does not infer extension support from a pre-upgrade socket attachment", async () => {
  await fixture([...extensions], async (request, socket, sent, restart) => {
    restart(true);
    expect((await request("context.prune")).status).toBe(409);
    expect(sent).toEqual([]); expect(socket.close).not.toHaveBeenCalled();
    expect((await request("context.read")).status).toBe(200);
  });
});

it("advertised support does not bypass final client authorization", async () => {
  await fixture([...extensions], async (request, _socket, sent, _restart, deny) => {
    deny();
    expect((await request("context.prune")).status).toBe(403);
    expect(sent).toEqual([]);
  });
});
