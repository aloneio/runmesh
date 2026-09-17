import { runnerRegistryFaults } from "./helpers/runner-registry-faults.js";
import worker from "../src/index.js";
import { randomBase64Url, sha256Hex } from "../src/security.js";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";

const key = "policy-admission-v1";
async function fixture() {
  const runnerId = `enrollment-recovery-${crypto.randomUUID()}`;
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName(runnerId));
  const identity = await runInDurableObject(registry, (instance, state) => {
    instance.registerRunner(runnerId, "a".repeat(64), Date.now(), undefined, "dedicated_user");
    const policy = instance.getDesiredPolicySnapshot(runnerId)!;
    state.storage.sql.exec("UPDATE runners SET connection_epoch=7, credential_version=3, state='offline', session_id=NULL, applied_policy_revision=?, active_policy_checksum=?, runner_reported_policy_revision=?, runner_reported_policy_checksum=?, policy_status='applied' WHERE runner_id=?", policy.revision, policy.checksum, policy.revision, policy.checksum, runnerId);
    return { lifecycleId: instance.getRunnerExecutionState(runnerId)!.lifecycle_id, revision: policy.revision, checksum: policy.checksum, proof: instance.getRunnerMutationState(runnerId, "uncommitted"), policy };
  });
  const runner = env.RUNNER.get(env.RUNNER.idFromName(runnerId));
  const admission = {
    fenced: false, reconciled: true, runnerId, lifecycleId: identity.lifecycleId,
    activeRevision: identity.revision, activeChecksum: identity.checksum,
    desiredRevision: identity.revision, desiredChecksum: identity.checksum,
    connectionEpoch: 7, credentialVersion: 3, sessionId: "old-session",
    mutationId: null, mutationPhase: "idle", preMutationActiveRevision: null,
    preMutationActiveChecksum: null, preMutationDesiredRevision: null,
    preMutationDesiredChecksum: null, lastReconciledAtMs: Date.now(),
  };
  // Copy only JSON evidence between test contexts, never a live I/O object.
  const route = async (_runnerId: string, action: string) => Response.json(action === "/active-policy" ? identity.policy : identity.proof);
  return { runnerId, registry, runner, admission, route };
}

it("regenerates an offline Runner enrollment after its old session fields remain populated", async () => {
  const f = await fixture();
  await runInDurableObject(f.runner, async (_existing, state) => {
    const { runner, registry } = runnerRegistryFaults(state, env, f.route);
    const target = runner as any;
    target.admissionState = f.admission;
    registry.request = f.route;
    await state.storage.put(key, f.admission);
    const mutation = "runner-enrollment-offline-repro";
    expect(await target.beginPolicyMutation(mutation, f.runnerId)).toBe("started");
  });
  const created = await runInDurableObject(f.registry, (registry) => registry.createRunnerEnrollment(f.runnerId, "c".repeat(43), "d".repeat(64), Date.now()));
  expect(created?.runner_id).toBe(f.runnerId);
  await runInDurableObject(f.runner, async (_existing, state) => {
    const { runner, registry } = runnerRegistryFaults(state, env, f.route);
    const target = runner as any;
    const mutation = "runner-enrollment-offline-repro";
    const cancelled = await target.cancelPolicyMutation(mutation) as Response;
    const response = cancelled.status === 204 ? "released" : await cancelled.text();
    console.log(JSON.stringify({ scenario: "offline_enrollment_recovery", code_created: true, cleanup_status: cancelled.status, cleanup_result: response }));
    expect(cancelled.status, response).toBe(204);
    expect(await target.admission()).toMatchObject({ fenced: true, reconciled: false });
    expect((await target.admission()).mutationId).not.toBe(mutation);
  });
});

it("hibernation preserves an owned precommit fence rather than replacing its mutation ID", async () => {
  const f = await fixture();
  await runInDurableObject(f.runner, async (_existing, state) => {
    const { runner, registry } = runnerRegistryFaults(state, env, f.route);
    const target = runner as any;
    target.admissionState = f.admission; registry.request = f.route;
    const mutation = "runner-enrollment-restart-repro";
    expect(await target.beginPolicyMutation(mutation, f.runnerId)).toBe("started");
    expect((await state.storage.get<any>(key)).mutationId).toBe(mutation);
    target.admissionState = undefined;
    const restored = await target.admission();
    console.log(JSON.stringify({ scenario: "enrollment_fence_reconstruction", expected_mutation: mutation, actual_mutation: restored.mutationId, phase: restored.mutationPhase }));
    expect(restored).toMatchObject({ fenced: true, reconciled: false, mutationId: mutation, mutationPhase: "precommit" });
    expect(await target.beginPolicyMutation("competing-mutation", f.runnerId)).toBe("conflict");
    expect((await target.cancelPolicyMutation(mutation)).status).toBe(204);
  });
});

it("incomplete mutation evidence cannot release any fence", async () => {
  const f = await fixture();
  await runInDurableObject(f.runner, async (_existing, state) => {
    const { runner, registry } = runnerRegistryFaults(state, env, f.route);
    const target = runner as any;
    target.admissionState = { ...f.admission, sessionId: null, connectionEpoch: null, credentialVersion: null };
    registry.request = async () => Response.json({ runner_exists: true });
    expect(await target.beginPolicyMutation("incomplete-proof", f.runnerId)).toBe("started");
    const cancelled = await target.cancelPolicyMutation("incomplete-proof") as Response;
    expect(cancelled.status).toBe(503);
    expect(await target.admission()).toMatchObject({ fenced: true, mutationId: "incomplete-proof" });
  });
});


it.each([
  ["changed credential", { credential_version: 4 }, 409],
  ["changed lifecycle", { lifecycle_id: "different-lifecycle-20260914" }, 409],
  ["committed mutation", { mutation_committed: true }, 409],
  ["deleted Runner", { runner_exists: false }, 409],
  ["missing commitment", { mutation_committed: undefined }, 503],
])("keeps isolation for %s", async (_name, change, status) => {
  const f = await fixture();
  const proof = await (await f.route(f.runnerId, "/mutation-state")).json() as Record<string, unknown>;
  await runInDurableObject(f.runner, async (_existing, state) => {
    const { runner, registry } = runnerRegistryFaults(state, env, f.route);
    const target = runner as any;
    target.admissionState = f.admission;
    registry.request = async () => Response.json({ ...proof, ...(change as object) });
    expect(await target.beginPolicyMutation("negative-recovery", f.runnerId)).toBe("started");
    expect((await target.cancelPolicyMutation("negative-recovery")).status).toBe(status);
    expect(await target.admission()).toMatchObject({ fenced: true, mutationId: "negative-recovery" });
  });
});

it("does not rewrite an unchanged owned fence on repeated reconstruction", async () => {
  const f = await fixture();
  await runInDurableObject(f.runner, async (instance, state) => {
    const target = instance as any;
    target.admissionState = f.admission;
    expect(await target.beginPolicyMutation("preserved-owner", f.runnerId)).toBe("started");
    const put = vi.spyOn(state.storage, "put");
    try {
      for (let i = 0; i < 50; i++) {
        target.admissionState = undefined;
        expect((await target.admission()).mutationId).toBe("preserved-owner");
      }
      expect(put).not.toHaveBeenCalled();
    } finally { put.mockRestore(); }
  });
});


it.each(["warm", "reconstructed", "cleanup-unavailable"])("browser enrollment regeneration succeeds via actual durable objects: %s", async (mode) => {
  const f = await fixture();
  const session = randomBase64Url(), csrf = randomBase64Url();
  const sessionHash = await sha256Hex(session), csrfHash = await sha256Hex(csrf);
  await runInDurableObject(f.registry, (instance) => {
    expect(instance.setupAdmin("synthetic-enrollment-admin", Date.now())).toBe(true);
    expect(instance.createAdminSession(sessionHash, csrfHash, Date.now()+60000, Date.now(), 1)).toBe(true);
  });
  const registryBinding = {
    idFromName: () => env.REGISTRY.idFromName(f.runnerId),
    get: () => env.REGISTRY.get(env.REGISTRY.idFromName(f.runnerId)),
  } as unknown as typeof env.REGISTRY;
  await runInDurableObject(f.runner, async (instance, state) => {
    const target = instance as any;
    target.admissionState = f.admission;
    target.env = { ...env, REGISTRY: registryBinding };
    await state.storage.put(key, f.admission);
  });
  const runnerBinding = {
    idFromName: env.RUNNER.idFromName.bind(env.RUNNER),
    get: () => ({ fetch: async (request: Request) => {
      if (mode === "cleanup-unavailable" && new URL(request.url).pathname === "/cancel-policy-mutation") {
        return Response.json({ error: { code: "mutation_state_changed", message: "PRIVATE_UPSTREAM_SENTINEL" } }, { status: 409 });
      }
      if (mode === "reconstructed" && new URL(request.url).pathname === "/cancel-policy-mutation") {
        await runInDurableObject(f.runner, (instance) => { (instance as any).admissionState = undefined; });
      }
      return f.runner.fetch(request);
    } }),
  } as unknown as typeof env.RUNNER;
  for (let attempt = 0; attempt < (mode === "cleanup-unavailable" ? 1 : 2); attempt++) {
    const response = await worker.fetch(new Request(`https://worker.test/admin/runners/${f.runnerId}/enrollment`, {
      method: "POST", headers: { origin: "https://worker.test", "content-type": "application/x-www-form-urlencoded",
        cookie: `__Host-runmesh_admin_session=${session}; __Host-runmesh_admin_csrf=${csrf}` },
      body: new URLSearchParams({ csrf_token: csrf, expected_execution_mode: "dedicated_user", execution_mode: "dedicated_user" }),
    }), { ...env, REGISTRY: registryBinding, RUNNER: runnerBinding }, {} as ExecutionContext);
    if (mode === "cleanup-unavailable") {
      expect(response.status).toBe(503);
      expect(response.headers.get("x-runmesh-error-code")).toBe("mutation_state_changed");
      expect(response.headers.get("x-runmesh-error-phase")).toBe("enrollment_fence_release");
      const text = await response.text();
      expect(text).toContain("temporary Runner safety lock");
      expect(text).not.toContain("PRIVATE_UPSTREAM_SENTINEL");
    } else {
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("cleanup is uncertain");
    }
  }
  await runInDurableObject(f.registry, (instance, state) => {
    expect(instance.getRunnerExecutionState(f.runnerId)!.runner.credential_version).toBe(3);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM runner_enrollments WHERE runner_id=? AND used_at_ms IS NULL", f.runnerId).one().n).toBe(1);
  });
  await runInDurableObject(f.runner, async (instance) => {
    const after = await (instance as any).admission();
    expect(after).toMatchObject({ fenced: true, reconciled: false });
    if (mode === "cleanup-unavailable") expect(after.mutationPhase).toBe("precommit");
    else expect(after.mutationId).toBe("restart-reconcile");
  });
});


it("a delayed cancellation cannot clear a newer mutation owner", async () => {
  const f = await fixture();
  const proof = await (await f.route(f.runnerId, "/mutation-state")).json();
  await runInDurableObject(f.runner, async (_existing, storageState) => {
    const { runner, registry } = runnerRegistryFaults(storageState, env, f.route);
    const target = runner as any;
    target.admissionState = f.admission;
    expect(await target.beginPolicyMutation("old-owner", f.runnerId)).toBe("started");
    registry.request = async () => {
      target.admissionState = { ...target.admissionState, mutationId: "new-owner" };
      await storageState.storage.put(key, target.admissionState);
      return Response.json(proof);
    };
    expect((await target.cancelPolicyMutation("old-owner")).status).toBe(409);
    expect(await target.admission()).toMatchObject({ fenced: true, mutationId: "new-owner" });
  });
});
