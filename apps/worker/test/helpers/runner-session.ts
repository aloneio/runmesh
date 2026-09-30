import { decodeWireFrame, encodeWireFrame, PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, runnerPolicyChecksum, type WireMessage } from "@aloneio/runmesh-protocol";
import { expect, vi } from "vitest";
import type { WorkerEnv } from "../../src/platform/env.js";
import { internalHeaders } from "../../src/security.js";
import { runnerRegistryFaults } from "./runner-registry-faults.js";

/** Exercise the real handshake, signed routes and policy reconciliation on DO storage.
 * Only the socket transport and the existing Registry request port are simulated. */
export async function runnerSession(state: DurableObjectState, env: WorkerEnv, options: {
  history?: boolean; credentialVersion?: number; lifecycleId?: string;
} = {}) {
  const runnerId = "r", sessionId = "session-test";
  const credentialVersion = options.credentialVersion ?? 1, lifecycleId = options.lifecycleId ?? "session-fixture-lifecycle";
  const input = { schema_version: 1 as const, runner_id: runnerId, revision: 1,
    runner_permissions: { read: true, edit: true, shell: true, job_control: true }, workspaces: [] };
  const policy = { ...input, checksum: runnerPolicyChecksum(input) };
  let attachment: unknown = { runnerId, sessionId, credentialVersion, epoch: 0, lifecycleId: null,
    protocolVersion: 0, authenticated: true, helloDeadlineMs: Date.now() + 10_000 };
  const frames: WireMessage[] = [];
  const socket = {
    readyState: WebSocket.OPEN, close: vi.fn(),
    deserializeAttachment: () => attachment,
    serializeAttachment: (value: unknown) => { attachment = value; },
    send: (raw: string) => {
      const frame = decodeWireFrame(raw); frames.push(frame);
      if (frame.type === "rpc.request") {
        void runner.webSocketMessage(socket, encodeWireFrame({ type: "rpc.response", protocol_version: PROTOCOL_CURRENT_VERSION,
          request_id: frame.request_id, result: { accepted: true } }));
      }
    },
  } as unknown as WebSocket;
  const port = new Proxy(state, { get(target, key) {
    if (key === "getWebSockets") return () => [socket];
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const { runner, registry } = runnerRegistryFaults(port, env, async (_id, action) => {
    if (action === "/connect") return Response.json({ epoch: 1, lifecycle_id: lifecycleId,
      ...(options.history ? { job_reporting: 2, job_history: {} } : {}) });
    if (action === "/session") return new Response(null, { status: 204 });
    if (action === "/access") return Response.json({ allowed: true });
    if (action === "/active-policy") return Response.json(policy);
    if (action === "/policy-readiness") return Response.json({ ok: true, policy_status: "applied",
      desired_revision: policy.revision, applied_revision: policy.revision, runner_reported_policy_revision: policy.revision,
      desired_checksum: policy.checksum, active_checksum: policy.checksum, runner_reported_policy_checksum: policy.checksum,
      connection_epoch: 1, credential_version: credentialVersion, session_id: sessionId, lifecycle_id: lifecycleId });
    throw new Error("Unexpected fixture Registry route: " + action);
  });
  const request = async (path: string, body: Record<string, unknown>) => {
    const payload = JSON.stringify(body);
    const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET!, "POST", path, payload);
    return runner.fetch(new Request("https://runner.internal" + path, { method: "POST", headers, body: payload }));
  };
  await runner.webSocketMessage(socket, encodeWireFrame({ type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION,
    request_id: "hello-session", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
    runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: {
      filesystem: true, process_execution: true, workspace_sync: true, pty: false, network_access: false,
      max_concurrent_jobs: 2, supported_rpc_methods: ["exec.start", "exec.run"], labels: {
        job_queue_protocol: "1", ...(options.history ? { job_reporting_protocol: "2" } : {}),
      } } } }));
  expect(socket.close).not.toHaveBeenCalled();
  expect(frames.map(frame => frame.type)).toEqual(["runner.welcome"]);
  frames.length = 0;
  return { runner, socket, registry, policy, frames, request, lifecycleId };
}
