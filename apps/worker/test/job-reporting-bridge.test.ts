import { runnerSession } from "./helpers/runner-session.js";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { launchDigest, verifyQueueGrant } from "../src/queue-grant.js";

/** Registry responses and signed mutation routes exercise the real bridge fences. */
async function bridge(recording: boolean | undefined, options: { history?: boolean; queue?: boolean; fault?: "unavailable" | "denied" | "policy-race" } = {}) {
  const { history: negotiated = true, queue = true, fault } = options;
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`reporting-bridge-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_existing, state) => {
    const { registry, policy, request, frames } = await runnerSession(state, env, { history: negotiated, queue });
    const base = registry.request;
    const requests: Array<{ path: string; input?: Record<string, unknown> }> = [];
    registry.request = async (runnerId, path, init) => {
      requests.push({ path, ...(typeof init.body === "string" ? { input: JSON.parse(init.body) } : {}) });
      if (path !== "/mcp-authorization") return base(runnerId, path, init);
      if (fault === "unavailable") return new Response("synthetic dependency failure", { status: 503 });
      if (fault === "denied") return Response.json({ ok: false }, { status: 403 });
      if (fault === "policy-race") expect((await request("/begin-policy-mutation", { mutation_id: "reporting-policy-race", runner_id: policy.runner_id })).status).toBe(204);
      return Response.json({ ok: true, ...(recording === undefined ? {} : { record_history: recording }) });
    };
    const response = await request("/rpc", {
      method: "exec.start", policy_revision: policy.revision, expected_policy_revision: policy.revision, expected_policy_checksum: policy.checksum,
      mcp_authorization: { client_id: "trusted-client", secret_version: 1 },
      params: { workspace_id: "w", command: "synthetic", shell: true, created_by_client_id: "forged-owner",
        record_history: recording !== true, queue_grant: { forged: true } },
    });
    const sent = frames.filter(frame => frame.type === "rpc.request");
    expect(requests.map(item => item.path)).toEqual(["/session", "/access", "/policy-readiness", "/active-policy", "/mcp-authorization", ...(fault ? [] : ["/session"])]);
    if (fault) { expect(response.status).toBe(fault === "unavailable" ? 503 : fault === "denied" ? 403 : 409); expect(sent).toHaveLength(0); return; }
    expect(response.status).toBe(200); expect(sent).toHaveLength(1);
    const params = sent[0]!.params as Record<string, unknown>;
    expect(params.created_by_client_id).toBe("trusted-client");
    if (negotiated) {
      expect(requests[4]!.input?.include_job_recording).toBe(true);
      expect(params.record_history).toBe(recording === true);
    } else {
      expect(requests[4]!.input).not.toHaveProperty("include_job_recording");
      expect(params).not.toHaveProperty("record_history");
    }
    if (queue) {
      const grant = await verifyQueueGrant(env.INTERNAL_CONTROL_SECRET, params.queue_grant);
      expect(grant?.launch_digest).toBe(await launchDigest(params));
      expect(grant?.client_id).toBe("trusted-client");
    } else expect(params).not.toHaveProperty("queue_grant");
  });
}

it.each([true, false, undefined])("capture decision %s reuses final auth, replaces caller claims, and validates the reply session", async record => bridge(record));
it("unnegotiated reporting retains the launch contract", async () => bridge(false, { history: false }));
it.each([true, false])("launch ownership remains authenticated without queue negotiation (reporting %s)", async history => bridge(false, { history, queue: false }));
it.each(["unavailable", "denied", "policy-race"] as const)("reporting changes cannot bypass %s dispatch rejection", async fault => bridge(true, { fault }));

it("internal launches without an MCP principal do not inherit a caller-provided client identity", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("reporting-internal-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const { policy, request, frames } = await runnerSession(state, env);
    const response = await request("/rpc", {
      method: "exec.start", policy_revision: policy.revision, expected_policy_revision: policy.revision, expected_policy_checksum: policy.checksum,
      params: { workspace_id: "w", command: "synthetic", shell: true, created_by_client_id: "caller-provided", queue_grant: { forged: true } },
    });
    expect(response.status).toBe(200);
    const sent = frames.filter(frame => frame.type === "rpc.request");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params).not.toHaveProperty("created_by_client_id");
    expect(sent[0]!.params).not.toHaveProperty("queue_grant");
  });
});

it("does not dispatch an unsigned internal request through an authenticated Runner session", async () => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("reporting-unsigned-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const { runner, frames, policy } = await runnerSession(state, env, { history: true });
    const response = await runner.fetch(new Request("https://runner.internal/rpc", { method: "POST", body: JSON.stringify({
      method: "exec.start", policy_revision: policy.revision, expected_policy_revision: policy.revision,
      expected_policy_checksum: policy.checksum, params: { workspace_id: "w", command: "synthetic", shell: true },
    }) }));
    expect(response.status).toBe(404);
    expect(frames).toEqual([]);
  });
});
