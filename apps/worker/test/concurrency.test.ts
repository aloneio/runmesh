import { runnerSession } from "./helpers/runner-session.js";
import type { RegistryFaults } from "./helpers/runner-registry-faults.js";
import { env, runInDurableObject } from "cloudflare:test";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, encodeWireFrame, runnerPolicyChecksum, type WireMessage } from "@aloneio/runmesh-protocol";
import { internalHeaders } from "../src/security.js";
import { describe, expect, it, vi } from "vitest";

const runnerId = "race-runner";
const checksum = policy(8).checksum;
const attachment = { runnerId, sessionId: "session-7", epoch: 7, credentialVersion: 3, lifecycleId: "lifecycle-race-7", protocolVersion: PROTOCOL_CURRENT_VERSION, authenticated: true, helloDeadlineMs: Date.now() + 60_000 };
function socket(send = vi.fn(), initial = attachment): WebSocket {
  let value = initial;
  return { deserializeAttachment: () => value, serializeAttachment: (next: typeof initial) => { value = next; }, send, close: vi.fn() } as unknown as WebSocket;
}
async function concurrencySession(state: DurableObjectState, options: { connectionEpoch?: number; sessionId?: string } = {}) {
  const session = await runnerSession(state, env, { runnerId, connectionEpoch: 7, sessionId: "session-7", credentialVersion: 3, lifecycleId: attachment.lifecycleId, policy: policy(7), ...options });
  const base = session.registry.request;
  session.registry.request = async (id, action, body) => action.startsWith("/mutation-state")
    ? Response.json({ runner_exists: true, mutation_committed: false, lifecycle_id: attachment.lifecycleId, credential_version: 3,
      connection_epoch: options.connectionEpoch ?? 7, session_id: options.sessionId ?? "session-7", runner_state: "online", policy_status: "applied",
      desired_revision: 7, desired_checksum: policy(7).checksum, applied_revision: 7, active_checksum: policy(7).checksum,
      runner_reported_revision: 7, runner_reported_checksum: policy(7).checksum }) : base(id, action, body);
  const begin = async (id: string) => (await session.request("/begin-policy-mutation", { mutation_id: id, runner_id: runnerId })).status;
  const admission = async () => { const response = await session.request("/admission-state"); expect(response.status).toBe(200); return response.json(); };
  const prepare = async (id: string, phase = "committed_pending") => {
    expect(await begin(id)).toBe(204);
    if (phase !== "precommit") {
      const previous = session.registry.request;
      session.registry.request = async (runner, action, body) => action === "/desired-policy"
        ? Response.json({ mutation_id: id, ...policy(8) }) : previous(runner, action, body);
      try { expect((await session.request("/mark-policy-committed", { mutation_id: id, phase, desired_revision: 8, desired_checksum: checksum })).status).toBe(204); }
      finally { session.registry.request = previous; }
    }
  };
  expect(await begin("fixture-reconcile")).toBe(204);
  expect((await session.request("/cancel-policy-mutation", { mutation_id: "fixture-reconcile" })).status).toBe(204);
  expect(await admission()).toMatchObject({ fenced: false, reconciled: true });
  return { ...session, begin, admission, prepare };
}
type TestSession = Awaited<ReturnType<typeof concurrencySession>>;
async function withRunner(name: string, callback: (target: TestSession, registry: RegistryFaults) => Promise<void>, options: { connectionEpoch?: number; sessionId?: string } = {}): Promise<void> {
  const stub = env.RUNNER.get(env.RUNNER.idFromName(name + "-" + crypto.randomUUID()));
  await runInDurableObject(stub, async (_existing, state) => {
    const target = await concurrencySession(state, options);
    await callback(target, target.registry);
  });
}
describe("RunnerDO concurrency finalization", () => {
  it.each([false, true])("confirms an idempotent mutation fence after an uncertain write (committed=%s)", async committed => {
    const stub = env.RUNNER.get(env.RUNNER.idFromName("precommit-persistence-" + crypto.randomUUID()));
    await runInDurableObject(stub, async (_instance, state) => {
      const target = await concurrencySession(state);
      const original = state.storage.put.bind(state.storage);
      const put = vi.spyOn(state.storage, "put").mockImplementationOnce((async (...args: unknown[]) => {
        if (committed) await (original as (...args: unknown[]) => Promise<void>)(...args);
        throw new Error("uncertain admission write");
      }) as typeof state.storage.put);
      try {
        expect(await target.begin("retry-owner")).toBe(503);
        expect(await target.admission()).toMatchObject({ fenced: true, mutationId: "retry-owner", mutationPhase: "precommit" });
        expect(await target.begin("retry-owner")).toBe(204);
        expect(await state.storage.get("policy-admission-v1")).toMatchObject({ fenced: true, mutationId: "retry-owner", mutationPhase: "precommit" });
        expect(put).toHaveBeenCalledTimes(committed ? 1 : 2);
        // Once confirmed, duplicate requests need no additional writes.
        expect(await target.begin("retry-owner")).toBe(204);
        expect(put).toHaveBeenCalledTimes(committed ? 1 : 2);
      } finally { put.mockRestore(); }
    });
  });

  it("does not let a delayed hello overwrite a concurrent policy fence", async () => {
    await withRunner("hello-policy-race", async (target, registry) => {
      let releaseConnect!: () => void;
      const connectBlocked = new Promise<void>((resolve) => { releaseConnect = resolve; });
      let connectStarted!: () => void;
      const connectRequested = new Promise<void>((resolve) => { connectStarted = resolve; });
      registry.request = async (_id, action) => {
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
      const helloInFlight = target.runner.webSocketMessage(socket(vi.fn(), { ...attachment, epoch: 0 }), encodeWireFrame(hello));
      await connectRequested;
      expect(await target.begin("concurrent-policy")).toBe(204);
      releaseConnect();
      await helloInFlight;
      await expect(target.admission()).resolves.toMatchObject({ fenced: true, mutationId: "concurrent-policy", mutationPhase: "precommit", connectionEpoch: 8, sessionId: "session-7" });
    });
  });

  it("does not let an older hello roll back a newer connection epoch", async () => {
    await withRunner("hello-epoch-race", async (target, registry) => {
      registry.request = async (_id, action) => {
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
      await target.runner.webSocketMessage(oldSocket, encodeWireFrame(hello));
      expect(oldSocket.close).toHaveBeenCalledWith(4000, "replaced by newer session");
      await expect(target.admission()).resolves.toMatchObject({ connectionEpoch: 9, sessionId: "new-session" });
    }, { connectionEpoch: 9, sessionId: "new-session" });
  });

  it("preserves a committed mutation's desired policy across a reconnect", async () => {
    await withRunner("hello-mutation-state", async (target, registry) => {
      await target.prepare("committed-policy", "committed_pending");
      registry.request = async (_id, action) => {
        if (action === "/connect") return Response.json({ epoch: 8, lifecycle_id: attachment.lifecycleId });
        if (action === "/session") return new Response(null, { status: 204 });
        return new Response(null, { status: 500 });
      };
      const reconnect = socket(vi.fn(), { ...attachment, sessionId: "reconnected", epoch: 0 });
      const hello: WireMessage = {
        type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello-mutation", min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
        runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } },
      };
      await target.runner.webSocketMessage(reconnect, encodeWireFrame(hello));
      await expect(target.admission()).resolves.toMatchObject({ fenced: true, mutationId: "committed-policy", mutationPhase: "committed_pending", desiredRevision: 8, desiredChecksum: checksum, connectionEpoch: 8, sessionId: "reconnected" });
    });
  });

  it("does not let a delayed session receipt replace a newly bound Runner lifecycle", async () => {
    await withRunner("hello-lifecycle-race", async (target, registry) => {
      let replacing = false;
      const hello: WireMessage = { type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "life-hello",
        min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
        runner: { runner_id: runnerId, runner_version: "test", platform: "test", architecture: "test", capabilities: {
          filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false,
          max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {} } } };
      registry.request = async (_id, action) => {
        if (action === "/connect") return Response.json(replacing ? { epoch: 1, lifecycle_id: "replacement-lifecycle" } : { epoch: 8, lifecycle_id: attachment.lifecycleId });
        if (action === "/session") {
          if (!replacing) {
            replacing = true;
            const replacement = socket(vi.fn(), { ...attachment, epoch: 0, credentialVersion: 1, lifecycleId: "replacement-lifecycle", sessionId: "replacement-session" });
            await target.runner.webSocketMessage(replacement, encodeWireFrame(hello));
            expect(replacement.close).not.toHaveBeenCalled();
          }
          return new Response(null, { status: 204 });
        }
        throw new Error("Unexpected Registry action: " + action);
      };
      const old = socket(vi.fn(), { ...attachment, epoch: 0 });
      await target.runner.webSocketMessage(old, encodeWireFrame(hello));
      expect(old.send).not.toHaveBeenCalled();
      expect(old.close).toHaveBeenCalledWith(4000, "replaced by newer session");
      expect(await target.admission()).toMatchObject({ lifecycleId: "replacement-lifecycle", credentialVersion: 1, connectionEpoch: 1, sessionId: "replacement-session" });
    });
  });

  for (const result of ["applied", "invalid"] as const) {
    it(`preserves a newer precommit while an older ${result} ACK awaits Registry`, async () => {
      await withRunner(`ack-${result}`, async (target, registry) => {
        await target.prepare("revision-8");
        let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
        let started!: () => void; const requested = new Promise<void>((resolve) => { started = resolve; });
        registry.request = async (_id, action) => {
          if (action === "/session") return new Response(null, { status: 204 });
          if (action === "/policy-ack") { started(); await blocked; return Response.json({ ack_result: result }); }
          if (action === "/policy-readiness") return Response.json({ ok: true, policy_status: "applied", desired_policy_mutation_id: "revision-8", desired_revision: 8, applied_revision: 8, runner_reported_policy_revision: 8, desired_checksum: checksum, active_checksum: checksum, runner_reported_policy_checksum: checksum, connection_epoch: 7, credential_version: 3, session_id: "session-7" });
          if (action === "/active-policy") return Response.json(policy(8));
          throw new Error(`unexpected ${action}`);
        };
        const inFlight = target.runner.webSocketMessage(socket(), encodeWireFrame({ type: "runner.policy_ack", protocol_version: PROTOCOL_CURRENT_VERSION, runner_id: runnerId, desired_revision: 8, desired_checksum: checksum, applied_revision: result === "applied" ? 8 : 7, applied_checksum: checksum, runner_reported_policy_revision: result === "applied" ? 8 : 7, runner_reported_policy_checksum: checksum, status: result, workspace_status: [] }));
        await requested;
        expect(await target.begin("revision-9")).toBe(204);
        release(); await inFlight;
        await expect(target.admission()).resolves.toMatchObject({ fenced: true, mutationId: "revision-9", mutationPhase: "precommit" });
      });
    });
  }

  it("does not send an old policy after a newer mutation owns the fence", async () => {
    await withRunner("policy-send", async (target, registry) => {
      await target.prepare("revision-8");
      target.frames.length = 0;
      let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void; const requested = new Promise<void>((resolve) => { started = resolve; });
      registry.request = async (_id, action) => {
        if (action === "/session") return new Response(null, { status: 204 });
        if (action === "/desired-policy") { started(); await blocked; return Response.json({ mutation_id: "revision-8", ...policy(8) }); }
        throw new Error(`unexpected ${action}`);
      };
      const inFlight = target.request("/policy", { mutation_id: "revision-8" });
      await requested;
      expect(await target.begin("revision-9")).toBe(204);
      release();
      await expect(inFlight).resolves.toMatchObject({ status: 409 });
      expect(target.frames).toEqual([]);
    });
  });

  it("recovers a Registry-committed policy precommit before a later mutation", async () => {
    await withRunner("commit-recovery", async (target, registry) => {
      await target.prepare("committed-before-mark", "precommit");
      registry.request = async (_id, action) => action.startsWith("/mutation-state") ? Response.json({ runner_exists: true, runner_state: "offline", mutation_committed: true, lifecycle_id: "lifecycle-race-7", desired_revision: 8, desired_checksum: checksum }) : new Response(null, { status: 500 });
      expect(await target.begin("next")).toBe(204);
      await expect(target.admission()).resolves.toMatchObject({ mutationId: "next", mutationPhase: "precommit" });
    });
  });

  for (const mutationId of ["credential-revoked", "credential-rotated"] as const) {
    it(`finalizes a committed ${mutationId} fence`, async () => {
      await withRunner(mutationId, async (target, registry) => {
        await target.prepare(mutationId, "precommit");
        registry.request = async (_id, action) => action.startsWith("/mutation-state") ? Response.json({ runner_exists: true, mutation_committed: true, credential_mutation_committed: true, lifecycle_id: "lifecycle-race-7" }) : new Response(null, { status: 500 });
        const response = await target.request("/revoke", { mutation_id: mutationId });
        expect(response.status).toBe(204);
        await expect(target.admission()).resolves.toMatchObject({ mutationId: null, mutationPhase: "restart_reconcile" });
        expect(await target.begin("later-policy")).toBe(204);
      });
    });
  }

  it("does not let a policy marker authorize the credential revoke finalizer", async () => {
    await withRunner("revoke-policy-marker", async (target, registry) => {
      await target.prepare("policy-marker", "precommit");

      registry.request = async (_id, action) => action.startsWith("/mutation-state")
        ? Response.json({ runner_exists: true, mutation_committed: true, credential_mutation_committed: false, lifecycle_id: "lifecycle-race-7" })
        : new Response(null, { status: 500 });
      const response = await target.request("/revoke", { mutation_id: "policy-marker" });
      expect(response.status).toBe(409);
      await expect(target.admission()).resolves.toMatchObject({ fenced: true, mutationId: "policy-marker", mutationPhase: "precommit" });
    });
  });

  it("does not finalize revoke from a non-precommit admission phase", async () => {
    await withRunner("revoke-non-precommit", async (target, registry) => {
      await target.prepare("policy-committed", "committed_pending");

      registry.request = async (_id, action) => action.startsWith("/mutation-state")
        ? Response.json({ runner_exists: true, mutation_committed: true, credential_mutation_committed: true, lifecycle_id: "lifecycle-race-7" })
        : new Response(null, { status: 500 });
      const response = await target.request("/revoke", { mutation_id: "policy-committed" });
      expect(response.status).toBe(409);
      await expect(target.admission()).resolves.toMatchObject({ fenced: true, mutationId: "policy-committed", mutationPhase: "committed_pending" });
    });
  });

  it("does not let a delayed revoke finalizer clear a newer mutation fence", async () => {
    await withRunner("revoke-finalizer-race", async (target, registry) => {
      await target.prepare("old-revoke", "precommit");

      let releaseRecovery!: () => void;
      const recoveryBlocked = new Promise<void>((resolve) => { releaseRecovery = resolve; });
      let firstRecovery!: () => void;
      const firstRecoveryStarted = new Promise<void>((resolve) => { firstRecovery = resolve; });
      let recoveryCalls = 0;
      registry.request = async (_id, action) => {
        if (action.startsWith("/mutation-state")) {
          recoveryCalls += 1;
          if (recoveryCalls === 1) {
            firstRecovery();
            await recoveryBlocked;
          }
          return Response.json({ runner_exists: true, runner_state: "offline", mutation_committed: true, credential_mutation_committed: true, lifecycle_id: "lifecycle-race-7", desired_revision: 8, desired_checksum: checksum });
        }
        throw new Error(`unexpected ${action}`);
      };
      const oldFinalizer = target.request("/revoke", { mutation_id: "old-revoke" });
      await firstRecoveryStarted;
      // beginPolicyMutation must recover the old precommit first, then acquire
      // the fence for the newer mutation while the old Registry check is still
      // awaiting. The delayed revoke is queued behind that newer owner.
      expect(await target.begin("new-revoke")).toBe(204);
      releaseRecovery();
      await expect(oldFinalizer).resolves.toMatchObject({ status: 409 });
      await expect(target.admission()).resolves.toMatchObject({ fenced: true, mutationId: "new-revoke", mutationPhase: "precommit" });
    });
  });

  it("does not let a delayed signed delete request clear a newer mutation fence", async () => {
    await withRunner("delete-finalizer-race", async (target) => {
      await target.prepare("old-delete");
      const payload = JSON.stringify({ mutation_id: "old-delete" });
      const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET!, "POST", "/delete", payload);
      let deliver!: () => void;
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        deliver = () => { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); };
      } });
      const oldFinalizer = target.runner.fetch(new Request("https://runner.internal/delete", { method: "POST", headers, body }));
      expect(await target.begin("new-delete")).toBe(204);
      deliver();
      await expect(oldFinalizer).resolves.toMatchObject({ status: 409 });
      await expect(target.admission()).resolves.toMatchObject({ fenced: true, mutationId: "new-delete", mutationPhase: "precommit" });
    });
  });

  for (const path of ["/begin-policy-mutation", "/mark-policy-committed", "/revoke", "/delete"]) {
    it("rejects unsigned control requests at " + path, async () => {
      await withRunner("unsigned-control", async (target) => {
        await target.prepare("owned", "precommit");
        const before = await target.admission();
        const response = await target.runner.fetch(new Request("https://runner.internal" + path, { method: "POST", body: JSON.stringify({ mutation_id: "owned", runner_id: runnerId }) }));
        expect(response.status).toBe(404);
        expect(await target.admission()).toEqual(before);
      });
    });
  }
});

function policy(revision: number) {
  const unsigned = { schema_version: 1 as const, runner_id: runnerId, revision, runner_permissions: { read: false, edit: false, shell: false, job_control: false }, workspaces: [] };
  return { ...unsigned, checksum: runnerPolicyChecksum(unsigned) };
}
