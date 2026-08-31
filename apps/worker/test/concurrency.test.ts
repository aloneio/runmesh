import { env, runInDurableObject } from "cloudflare:test";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, encodeWireFrame, runnerPolicyChecksum } from "@aloneio/runmesh-protocol";
import { describe, expect, it, vi } from "vitest";

interface Admission {
  fenced: boolean; reconciled: boolean; runnerId: string | null;
  activeRevision: number | null; activeChecksum: string | null;
  desiredRevision: number | null; desiredChecksum: string | null;
  connectionEpoch: number | null; credentialVersion: number | null; lifecycleId: string | null; sessionId: string | null;
  mutationId: string | null; mutationPhase: "idle" | "precommit" | "committed_pending" | "offline_pending" | "invalid" | "restart_reconcile";
  preMutationActiveRevision: number | null; preMutationActiveChecksum: string | null;
  preMutationDesiredRevision: number | null; preMutationDesiredChecksum: string | null;
  lastReconciledAtMs: number | null;
}
interface TestRunnerDO {
  admissionState?: Admission;
  registryRequest: (runnerId: string, action: string, init: RequestInit) => Promise<Response>;
  verifyInternalRequest: (body: string, request: Request) => Promise<boolean>;
  admission: () => Promise<Admission>;
  beginPolicyMutation: (mutationId: string, runnerId?: string) => Promise<"started" | "idempotent" | "conflict">;
  webSocketMessage: (socket: WebSocket, raw: string | ArrayBuffer) => Promise<void>;
  fetch: (request: Request) => Promise<Response>;
}

const runnerId = "race-runner";
const checksum = "a".repeat(64);
const attachment = { runnerId, sessionId: "session-7", epoch: 7, credentialVersion: 3, lifecycleId: "lifecycle-race-7", protocolVersion: PROTOCOL_CURRENT_VERSION, authenticated: true, helloDeadlineMs: Date.now() + 60_000 };
function state(mutationId: string, mutationPhase: Admission["mutationPhase"] = "committed_pending"): Admission {
  return { fenced: true, reconciled: false, runnerId, activeRevision: null, activeChecksum: null, desiredRevision: 8, desiredChecksum: checksum, connectionEpoch: 7, credentialVersion: 3, lifecycleId: "lifecycle-race-7", sessionId: "session-7", mutationId, mutationPhase, preMutationActiveRevision: 7, preMutationActiveChecksum: checksum, preMutationDesiredRevision: 7, preMutationDesiredChecksum: checksum, lastReconciledAtMs: null };
}
function readyState(): Admission {
  return { fenced: false, reconciled: true, runnerId, activeRevision: 7, activeChecksum: checksum, desiredRevision: 7, desiredChecksum: checksum, connectionEpoch: 7, credentialVersion: 3, lifecycleId: "lifecycle-race-7", sessionId: "session-7", mutationId: null, mutationPhase: "idle", preMutationActiveRevision: null, preMutationActiveChecksum: null, preMutationDesiredRevision: null, preMutationDesiredChecksum: null, lastReconciledAtMs: Date.now() };
}
function socket(send = vi.fn(), socketAttachment = attachment): WebSocket { return { deserializeAttachment: () => socketAttachment, serializeAttachment: vi.fn(), send, close: vi.fn() } as unknown as WebSocket; }
async function withRunner(name: string, callback: (target: TestRunnerDO) => Promise<void>): Promise<void> {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(`${name}-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance) => callback(instance as unknown as TestRunnerDO));
}

describe("RunnerDO concurrency finalization", () => {
  it("does not let a delayed hello overwrite a concurrent policy fence", async () => {
    await withRunner("hello-policy-race", async (target) => {
      target.admissionState = readyState();
      let releaseConnect!: () => void;
      const connectBlocked = new Promise<void>((resolve) => { releaseConnect = resolve; });
      let connectStarted!: () => void;
      const connectRequested = new Promise<void>((resolve) => { connectStarted = resolve; });
      target.registryRequest = async (_id, action) => {
        if (action === "/connect") {
          connectStarted();
          await connectBlocked;
          return Response.json({ epoch: 8, lifecycle_id: attachment.lifecycleId });
        }
        if (action === "/session") return new Response(null, { status: 204 });
        throw new Error(`unexpected ${action}`);
      };
      const hello: WireMessage = {
        type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello-race", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
        runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
      };
      const helloInFlight = target.webSocketMessage(socket(vi.fn(), { ...attachment, epoch: 0 }), encodeWireFrame(hello));
      await connectRequested;
      expect(await target.beginPolicyMutation("concurrent-policy", runnerId)).toBe("started");
      releaseConnect();
      await helloInFlight;
      await expect(target.admission()).resolves.toMatchObject({ fenced: true, mutationId: "concurrent-policy", mutationPhase: "precommit", connectionEpoch: 8, sessionId: "session-7" });
    });
  });

  it("does not let an older hello roll back a newer connection epoch", async () => {
    await withRunner("hello-epoch-race", async (target) => {
      target.admissionState = { ...readyState(), connectionEpoch: 9, sessionId: "new-session" };
      target.registryRequest = async (_id, action) => {
        if (action === "/connect") return Response.json({ epoch: 8, lifecycle_id: attachment.lifecycleId });
        if (action === "/session") return new Response(null, { status: 204 });
        return new Response(null, { status: 500 });
      };
      const oldAttachment = { ...attachment, sessionId: "old-session", epoch: 0 };
      const oldSocket = socket(vi.fn(), oldAttachment);
      const hello: WireMessage = {
        type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello-old", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
        runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
      };
      await target.webSocketMessage(oldSocket, encodeWireFrame(hello));
      expect(oldSocket.close).toHaveBeenCalledWith(4000, "replaced by newer session");
      await expect(target.admission()).resolves.toMatchObject({ connectionEpoch: 9, sessionId: "new-session" });
    });
  });

  it("preserves a committed mutation's desired policy across a reconnect", async () => {
    await withRunner("hello-mutation-state", async (target) => {
      target.admissionState = state("committed-policy", "committed_pending");
      target.registryRequest = async (_id, action) => {
        if (action === "/connect") return Response.json({ epoch: 8, lifecycle_id: attachment.lifecycleId });
        if (action === "/session") return new Response(null, { status: 204 });
        return new Response(null, { status: 500 });
      };
      const reconnect = socket(vi.fn(), { ...attachment, sessionId: "reconnected", epoch: 0 });
      const hello: WireMessage = {
        type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello-mutation", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
        runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
      };
      await target.webSocketMessage(reconnect, encodeWireFrame(hello));
      await expect(target.admission()).resolves.toMatchObject({ fenced: true, mutationId: "committed-policy", mutationPhase: "committed_pending", desiredRevision: 8, desiredChecksum: checksum, connectionEpoch: 8, sessionId: "reconnected" });
    });
  });

  for (const result of ["applied", "invalid"] as const) {
    it(`preserves a newer precommit while an older ${result} ACK awaits Registry`, async () => {
      await withRunner(`ack-${result}`, async (target) => {
        target.admissionState = state("revision-8");
        let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
        let started!: () => void; const requested = new Promise<void>((resolve) => { started = resolve; });
        target.registryRequest = async (_id, action) => {
          if (action === "/session") return new Response(null, { status: 204 });
          if (action === "/policy-ack") { started(); await blocked; return Response.json({ ack_result: result }); }
          if (action === "/policy-readiness") return Response.json({ ok: true, policy_status: "applied", desired_policy_mutation_id: "revision-8", desired_revision: 8, applied_revision: 8, runner_reported_policy_revision: 8, desired_checksum: checksum, active_checksum: checksum, runner_reported_policy_checksum: checksum, connection_epoch: 7, credential_version: 3, session_id: "session-7" });
          if (action === "/active-policy") return Response.json(policy(8));
          throw new Error(`unexpected ${action}`);
        };
        const inFlight = target.webSocketMessage(socket(), encodeWireFrame({ type: "runner.policy_ack", protocol_version: PROTOCOL_CURRENT_VERSION, runner_id: runnerId, desired_revision: 8, desired_checksum: checksum, applied_revision: result === "applied" ? 8 : 7, applied_checksum: checksum, runner_reported_policy_revision: result === "applied" ? 8 : 7, runner_reported_policy_checksum: checksum, status: result, workspace_status: [] }));
        await requested;
        expect(await target.beginPolicyMutation("revision-9", runnerId)).toBe("started");
        release(); await inFlight;
        await expect(target.admission()).resolves.toMatchObject({ fenced: true, mutationId: "revision-9", mutationPhase: "precommit" });
      });
    });
  }

  it("does not send an old policy after a newer mutation owns the fence", async () => {
    await withRunner("policy-send", async (target) => {
      target.admissionState = state("revision-8"); target.verifyInternalRequest = async () => true;
      const send = vi.fn(); const ws = socket(send);
      let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void; const requested = new Promise<void>((resolve) => { started = resolve; });
      target.registryRequest = async (_id, action) => {
        if (action === "/session") return new Response(null, { status: 204 });
        if (action === "/desired-policy") { started(); await blocked; return Response.json({ mutation_id: "revision-8", ...policy(8) }); }
        throw new Error(`unexpected ${action}`);
      };
      const context = target as unknown as { ctx: { getWebSockets: (tag: string) => WebSocket[] } };
      context.ctx.getWebSockets = () => [ws];
      const inFlight = target.fetch(new Request("https://runner.internal/policy", { method: "POST", body: JSON.stringify({ mutation_id: "revision-8" }) }));
      await requested;
      expect(await target.beginPolicyMutation("revision-9", runnerId)).toBe("started");
      release();
      await expect(inFlight).resolves.toMatchObject({ status: 409 });
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("recovers a Registry-committed policy precommit before a later mutation", async () => {
    await withRunner("commit-recovery", async (target) => {
      target.admissionState = state("committed-before-mark", "precommit");
      target.registryRequest = async (_id, action) => action.startsWith("/mutation-state") ? Response.json({ runner_exists: true, runner_state: "offline", mutation_committed: true, desired_revision: 8, desired_checksum: checksum }) : new Response(null, { status: 500 });
      expect(await target.beginPolicyMutation("next", runnerId)).toBe("started");
      await expect(target.admission()).resolves.toMatchObject({ mutationId: "next", mutationPhase: "precommit" });
    });
  });

  for (const mutationId of ["credential-revoked", "credential-rotated"] as const) {
    it(`finalizes a committed ${mutationId} fence`, async () => {
      await withRunner(mutationId, async (target) => {
        target.admissionState = state(mutationId, "precommit"); target.verifyInternalRequest = async () => true;
        target.registryRequest = async (_id, action) => action.startsWith("/mutation-state") ? Response.json({ runner_exists: true, mutation_committed: true }) : new Response(null, { status: 500 });
        const response = await target.fetch(new Request("https://runner.internal/revoke", { method: "POST", body: JSON.stringify({ mutation_id: mutationId }) }));
        expect(response.status).toBe(204);
        await expect(target.admission()).resolves.toMatchObject({ mutationId: null, mutationPhase: "restart_reconcile" });
        expect(await target.beginPolicyMutation("later-policy", runnerId)).toBe("started");
      });
    });
  }
});

function policy(revision: number) {
  const unsigned = { schema_version: 1 as const, runner_id: runnerId, revision, runner_permissions: { read: false, edit: false, shell: false, job_control: false }, workspaces: [] };
  return { ...unsigned, checksum: runnerPolicyChecksum(unsigned) };
}
