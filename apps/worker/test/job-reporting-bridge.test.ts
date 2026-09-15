import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { encodeWireFrame, decodeWireFrame } from "@aloneio/runmesh-protocol";
import { launchDigest, verifyQueueGrant } from "../src/queue-grant.js";

/** Faults are confined to the isolated DO's network/policy test seams.
 * The real bridge encodes the request and resolves its websocket response. */
async function bridge(recording: boolean | undefined, negotiated = true, fault?: "unavailable" | "denied" | "policy-race") {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`reporting-bridge-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async instance => {
    const target = instance as any;
    const attachment = { runnerId: "r", sessionId: "s", epoch: 1, credentialVersion: 1, lifecycleId: "reporting-lifecycle",
      protocolVersion: 2, authenticated: true, queueProtocol: 1, ...(negotiated ? { historyProtocol: 2 } : {}) };
    let authorized = false;
    const sent: Record<string, any>[] = [], requests: Array<{ path: string; input?: Record<string, unknown> }> = [];
    const socket = { deserializeAttachment: () => attachment, close: vi.fn(), send: (bytes: string) => {
      const frame = decodeWireFrame(bytes); if (frame.type !== "rpc.request") throw new Error("unexpected frame");
      sent.push(frame);
      void target.webSocketMessage(socket, encodeWireFrame({ type: "rpc.response", protocol_version: 2,
        request_id: frame.request_id, result: { accepted: true } }));
    } } as unknown as WebSocket;
    target.currentRunnerSocket = async () => socket;
    target.verifyInternalRequest = async () => true;
    target.isCurrent = async () => true;
    target.admissionState = {};
    target.admitOrReconcileProtectedRpc = async () => true;
    target.admitsProtectedRpc = () => !(authorized && fault === "policy-race");
    target.registryRequest = async (_runner: string, path: string, init: RequestInit) => {
      requests.push({ path, ...(typeof init.body === "string" ? { input: JSON.parse(init.body) } : {}) });
      if (path === "/access") return Response.json({ allowed: true });
      if (path !== "/mcp-authorization") throw new Error("unexpected extra lookup");
      authorized = true;
      if (fault === "unavailable") return new Response("synthetic dependency failure", { status: 503 });
      if (fault === "denied") return Response.json({ ok: false }, { status: 403 });
      return Response.json({ ok: true, ...(recording === undefined ? {} : { record_history: recording }) });
    };
    const response = await target.fetch(new Request("https://runner.internal/rpc", { method: "POST", body: JSON.stringify({
      method: "exec.start", policy_revision: 1, expected_policy_revision: 1, expected_policy_checksum: "a".repeat(64),
      mcp_authorization: { client_id: "trusted-client", secret_version: 1 },
      params: { workspace_id: "w", command: "synthetic", shell: true, created_by_client_id: "forged-owner",
        record_history: recording !== true, queue_grant: { forged: true } },
    }) }));
    expect(requests.map(item => item.path)).toEqual(["/access", "/mcp-authorization"]);
    if (fault) { expect(response.status).toBe(fault === "unavailable" ? 503 : fault === "denied" ? 403 : 409); expect(sent).toHaveLength(0); return; }
    expect(response.status).toBe(200); expect(sent).toHaveLength(1);
    const params = sent[0]!.params;
    expect(params.created_by_client_id).toBe("trusted-client");
    if (negotiated) {
      expect(requests[1]!.input?.include_job_recording).toBe(true);
      expect(params.record_history).toBe(recording === true);
    } else {
      expect(requests[1]!.input).not.toHaveProperty("include_job_recording");
      expect(params).not.toHaveProperty("record_history");
    }
    const grant = await verifyQueueGrant(env.INTERNAL_CONTROL_SECRET, params.queue_grant);
    expect(grant?.launch_digest).toBe(await launchDigest(params));
    expect(grant?.client_id).toBe("trusted-client");
  });
}

it.each([true, false, undefined])("capture decision %s uses final auth without an extra request and replaces caller claims", async record => bridge(record));
it("unnegotiated runners retain the legacy launch contract", async () => bridge(false, false));
it.each(["unavailable", "denied", "policy-race"] as const)("reporting changes cannot bypass %s dispatch rejection", async fault => bridge(true, true, fault));
