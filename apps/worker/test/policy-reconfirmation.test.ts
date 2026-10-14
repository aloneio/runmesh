import { env, runInDurableObject } from "cloudflare:test";
import { encodeWireFrame, decodeWireFrame, PROTOCOL_CURRENT_VERSION, runnerPolicyChecksum } from "@aloneio/runmesh-protocol";
import { expect, it, vi } from "vitest";
import { RunnerDO } from "../src/runner-do.js";
import { RunnerPolicyRecovery } from "../src/platform/runner-policy-recovery.js";
import { FENCED_ADMISSION, RESTART_RECONCILE_MUTATION_ID, type AdmissionState } from "../src/domain/runner-admission.js";

const identity = { runnerId: "policy-recovery-runner", sessionId: "policy-session", epoch: 1, credentialVersion: 1, lifecycleId: "a".repeat(64) };
const fields = { schema_version: 1 as const, runner_id: identity.runnerId, revision: 1,
  runner_permissions: { read: true, edit: true, shell: true, job_control: true }, workspaces: [] };
const policy = { ...fields, checksum: runnerPolicyChecksum(fields) };
const initial: AdmissionState = { ...FENCED_ADMISSION, runnerId: identity.runnerId, connectionEpoch: identity.epoch,
  credentialVersion: identity.credentialVersion, lifecycleId: identity.lifecycleId, sessionId: identity.sessionId,
  desiredRevision: policy.revision, desiredChecksum: policy.checksum, mutationId: RESTART_RECONCILE_MUTATION_ID };
const ack = () => encodeWireFrame({ type: "runner.policy_ack", protocol_version: PROTOCOL_CURRENT_VERSION, runner_id: identity.runnerId,
  desired_revision: 1, desired_checksum: policy.checksum, applied_revision: 1, applied_checksum: policy.checksum,
  runner_reported_policy_revision: 1, runner_reported_policy_checksum: policy.checksum, status: "applied", workspace_status: [] });
const heartbeat = () => encodeWireFrame({ type: "runner.heartbeat", protocol_version: PROTOCOL_CURRENT_VERSION,
  runner_id: identity.runnerId, sent_at_ms: Date.now(), active_job_ids: [] });
function socket() {
  let value: Record<string, unknown> = { ...identity, authenticated: true, helloCompleted: true, protocolVersion: PROTOCOL_CURRENT_VERSION, helloDeadlineMs: Date.now() + 10000 };
  const send = vi.fn(), close = vi.fn();
  const ws = { readyState: WebSocket.OPEN, send, close, deserializeAttachment: () => structuredClone(value),
    serializeAttachment: (next: Record<string, unknown>) => { value = structuredClone(next); } } as unknown as WebSocket;
  return { ws, send, close, attachment: () => value };
}
function registry() {
  let healthy = false, sessionStatus = 204;
  const request = vi.fn(async (_runner: string, action: string) => {
    if (action === "/policy-ack") return healthy ? Response.json({ ack_result: "applied" }) : new Response(null, { status: 503 });
    if (action === "/heartbeat") return new Response(null, { status: 204 });
    if (action === "/session") return new Response(null, { status: sessionStatus });
    if (action === "/desired-policy") return Response.json({ ...policy, mutation_id: null });
    if (action === "/active-policy") return Response.json(policy);
    if (action === "/policy-readiness") return Response.json({ ok: true, policy_status: "applied", desired_revision: 1,
      applied_revision: 1, runner_reported_policy_revision: 1, desired_checksum: policy.checksum, active_checksum: policy.checksum,
      runner_reported_policy_checksum: policy.checksum, connection_epoch: 1, credential_version: 1,
      lifecycle_id: identity.lifecycleId, session_id: identity.sessionId, desired_policy_mutation_id: null });
    throw new Error(`Unexpected recovery route ${action}`);
  });
  return { request, recover: () => { healthy = true; }, session: (status: number) => { sessionStatus = status; } };
}

it.each([false, true])("reconfirms a lost policy ACK without reconnecting or granting from the recovery marker, hibernated=%s", async hibernated => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("policy-ack-recovery-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    await state.storage.put("policy-admission-v1", initial);
    const f = socket(), r = registry(), sockets = vi.spyOn(state, "getWebSockets").mockReturnValue([f.ws]);
    let instance = new RunnerDO(state, env, { registryRequest: r.request });
    try {
      await instance.webSocketMessage(f.ws, ack());
      expect(f.attachment().policyAckRecovery).toEqual(expect.any(String));
      expect(await state.storage.get("policy-admission-v1")).toMatchObject({ fenced: true, reconciled: false });
      if (hibernated) instance = new RunnerDO(state, env, { registryRequest: r.request });
      r.recover();
      await instance.webSocketMessage(f.ws, heartbeat());
      expect(f.send).toHaveBeenCalledOnce();
      expect(decodeWireFrame(f.send.mock.calls[0]![0] as string)).toMatchObject({ type: "runner.policy_update", policy });
      expect(await state.storage.get("policy-admission-v1")).toMatchObject({ fenced: true, reconciled: false });
      await instance.webSocketMessage(f.ws, ack());
      expect(await state.storage.get("policy-admission-v1")).toMatchObject({ fenced: false, reconciled: true, activeRevision: 1, activeChecksum: policy.checksum });
      expect(f.attachment().policyAckRecovery).toBeUndefined(); expect(f.close).not.toHaveBeenCalled();
      expect(r.request.mock.calls.map(call => call[1])).toEqual(["/policy-ack", "/heartbeat", "/desired-policy", "/session", "/policy-ack", "/policy-readiness", "/active-policy"]);
    } finally { sockets.mockRestore(); }
  });
});


it.each([401, 403, 409, 503])("rechecks current session before policy redelivery and refuses status %s", async status => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("policy-ack-fence-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    await state.storage.put("policy-admission-v1", initial);
    const f = socket(), r = registry(), sockets = vi.spyOn(state, "getWebSockets").mockReturnValue([f.ws]);
    const instance = new RunnerDO(state, env, { registryRequest: r.request });
    try {
      await instance.webSocketMessage(f.ws, ack()); r.session(status);
      await instance.webSocketMessage(f.ws, heartbeat());
      expect(f.send).not.toHaveBeenCalled();
      expect(await state.storage.get("policy-admission-v1")).toMatchObject({ fenced: true, reconciled: false });
      if (status === 503) expect(f.close).not.toHaveBeenCalled();
      else expect(f.close.mock.calls[0]?.[0]).toBe(status === 409 ? 4000 : 4001);
    } finally { sockets.mockRestore(); }
  });
});

it.each(["precommit", "committed_pending"] as const)("cannot redeliver a policy across another mutation owner in phase %s", async mutationPhase => {
  const stub = env.RUNNER.get(env.RUNNER.idFromName("policy-ack-mutation-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    await state.storage.put("policy-admission-v1", { ...initial, mutationId: "other-policy-mutation", mutationPhase });
    const f = socket(), r = registry(), sockets = vi.spyOn(state, "getWebSockets").mockReturnValue([f.ws]);
    const instance = new RunnerDO(state, env, { registryRequest: r.request });
    try {
      await instance.webSocketMessage(f.ws, ack());
      await instance.webSocketMessage(f.ws, heartbeat());
      expect(f.send).not.toHaveBeenCalled(); expect(f.close).not.toHaveBeenCalled();
      expect(await state.storage.get("policy-admission-v1")).toMatchObject({ fenced: true, mutationId: "other-policy-mutation" });
    } finally { sockets.mockRestore(); }
  });
});

it("does not let an older ACK completion erase a newer pending generation", async () => {
  const f = socket(), recovery = new RunnerPolicyRecovery(), first = recovery.begin(f.ws), second = recovery.begin(f.ws);
  recovery.complete(f.ws, first);
  expect(f.attachment().policyAckRecovery).toBe(second);
  const reconfirm = vi.fn(async () => {});
  await new RunnerPolicyRecovery().retry(f.ws, reconfirm);
  expect(reconfirm).toHaveBeenCalledOnce();
  recovery.complete(f.ws, second);
  await recovery.retry(f.ws, reconfirm);
  expect(reconfirm).toHaveBeenCalledOnce();
});
