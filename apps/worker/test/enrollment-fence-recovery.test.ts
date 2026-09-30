import { runnerRegistryFaults } from "./helpers/runner-registry-faults.js";
import { runnerSession } from "./helpers/runner-session.js";
import type { RunnerDO } from "../src/runner-do.js";
import { requestRunnerRegistry } from "../src/platform/runner-registry.js";
import worker from "../src/index.js";
import { internalHeaders, randomBase64Url, sha256Hex } from "../src/security.js";
import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";

async function fixture() {
  const runnerId = "enrollment-recovery-" + crypto.randomUUID();
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName(runnerId));
  const identity = await runInDurableObject(registry, (instance, state) => {
    instance.registerRunner(runnerId, "a".repeat(64), Date.now(), undefined, "dedicated_user");
    const policy = instance.getDesiredPolicySnapshot(runnerId)!;
    state.storage.sql.exec("UPDATE runners SET connection_epoch=7, credential_version=3, state='offline', session_id=NULL, applied_policy_revision=?, active_policy_checksum=?, runner_reported_policy_revision=?, runner_reported_policy_checksum=?, policy_status='applied' WHERE runner_id=?", policy.revision, policy.checksum, policy.revision, policy.checksum, runnerId);
    return { lifecycleId: instance.getRunnerExecutionState(runnerId)!.lifecycle_id, proof: instance.getRunnerMutationState(runnerId, "uncommitted"), policy };
  });
  const runner = env.RUNNER.get(env.RUNNER.idFromName(runnerId));
  // Only JSON evidence crosses the Durable Object test contexts.
  const route = async (_runnerId: string, action: string) => {
    if (action === "/active-policy") return Response.json(identity.policy);
    if (action.startsWith("/mutation-state?")) return Response.json(identity.proof);
    throw new Error("Unexpected recovery Registry route: " + action);
  };
  return { runnerId, registry, runner, ...identity, route };
}

function control(runner: Pick<RunnerDO, "fetch">, runnerId: string) {
  const request = async (path: string, input?: Record<string, unknown>) => {
    const method = input === undefined ? "GET" : "POST", body = input === undefined ? "" : JSON.stringify(input);
    const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET, method, path, body);
    return runner.fetch(new Request("https://runner.internal" + path, { method, headers, ...(input === undefined ? {} : { body }) }));
  };
  return {
    begin: (mutationId: string) => request("/begin-policy-mutation", { mutation_id: mutationId, runner_id: runnerId }),
    cancel: (mutationId: string) => request("/cancel-policy-mutation", { mutation_id: mutationId }),
    admission: async () => {
      const response = await request("/admission-state");
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, unknown>>;
    },
  };
}

/** Establish and reconcile a session, then deliver its real close event.
 * The resulting historical identity is never assigned to private state. */
async function offlineRunner(state: DurableObjectState, f: Awaited<ReturnType<typeof fixture>>, workerEnv = env) {
  const session = await runnerSession(state, workerEnv, {
    runnerId: f.runnerId, connectionEpoch: 7, credentialVersion: 3, lifecycleId: f.lifecycleId, policy: f.policy,
  });
  const api = control(session.runner, f.runnerId), base = session.registry.request;
  session.registry.request = async (runnerId, action, init) => {
    if (action.startsWith("/mutation-state?")) return Response.json({ ...f.proof, runner_state: "online", session_id: "session-test" });
    if (action === "/disconnect") return new Response(null, { status: 204 });
    return base(runnerId, action, init);
  };
  expect((await api.begin("prepare-offline-session")).status).toBe(204);
  expect((await api.cancel("prepare-offline-session")).status).toBe(204);
  expect(await api.admission()).toMatchObject({ fenced: false, reconciled: true });
  await session.disconnect();
  session.registry.request = f.route;
  expect(await api.admission()).toMatchObject({ sessionId: "session-test", connectionEpoch: 7, credentialVersion: 3 });
  return { ...session, ...api };
}

it("regenerates an offline Runner enrollment after its old session fields remain populated", async () => {
  const f = await fixture(), mutation = "runner-enrollment-offline-repro";
  await runInDurableObject(f.runner, async (_existing, state) => {
    const target = await offlineRunner(state, f);
    expect((await target.begin(mutation)).status).toBe(204);
  });
  const created = await runInDurableObject(f.registry, registry => registry.createRunnerEnrollment(f.runnerId, "c".repeat(43), "d".repeat(64), Date.now()));
  expect(created?.runner_id).toBe(f.runnerId);
  await runInDurableObject(f.runner, async (_existing, state) => {
    const target = control(runnerRegistryFaults(state, env, f.route).runner, f.runnerId);
    expect((await target.cancel(mutation)).status).toBe(204);
    expect(await target.admission()).toMatchObject({ fenced: true, reconciled: false, mutationId: "restart-reconcile" });
  });
});

it("hibernation preserves an owned precommit fence rather than replacing its mutation ID", async () => {
  const f = await fixture();
  await runInDurableObject(f.runner, async (_existing, state) => {
    const target = await offlineRunner(state, f), mutation = "runner-enrollment-restart-repro";
    expect((await target.begin(mutation)).status).toBe(204);
    const restored = control(runnerRegistryFaults(state, env, f.route).runner, f.runnerId);
    expect(await restored.admission()).toMatchObject({ fenced: true, reconciled: false, mutationId: mutation, mutationPhase: "precommit" });
    expect((await restored.begin("competing-mutation")).status).toBe(409);
    expect((await restored.cancel(mutation)).status).toBe(204);
  });
});

it("incomplete mutation evidence cannot release any fence", async () => {
  const f = await fixture();
  await runInDurableObject(f.runner, async (_existing, state) => {
    const { runner } = runnerRegistryFaults(state, env, async () => Response.json({ runner_exists: true }));
    const target = control(runner, f.runnerId);
    expect((await target.begin("incomplete-proof")).status).toBe(204);
    expect((await target.cancel("incomplete-proof")).status).toBe(503);
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
  await runInDurableObject(f.runner, async (_existing, state) => {
    const target = await offlineRunner(state, f);
    target.registry.request = async () => Response.json({ ...f.proof, ...(change as object) });
    expect((await target.begin("negative-recovery")).status).toBe(204);
    expect((await target.cancel("negative-recovery")).status).toBe(status);
    expect(await target.admission()).toMatchObject({ fenced: true, mutationId: "negative-recovery" });
  });
});

it("does not rewrite an unchanged owned fence on repeated reconstruction", async () => {
  const f = await fixture();
  await runInDurableObject(f.runner, async (_existing, state) => {
    const target = await offlineRunner(state, f);
    expect((await target.begin("preserved-owner")).status).toBe(204);
    const put = vi.spyOn(state.storage, "put");
    try {
      for (let i = 0; i < 50; i++) {
        const restored = control(runnerRegistryFaults(state, env, f.route).runner, f.runnerId);
        expect(await restored.admission()).toMatchObject({ mutationId: "preserved-owner" });
      }
      expect(put).not.toHaveBeenCalled();
    } finally { put.mockRestore(); }
  });
});

it.each(["warm", "reconstructed", "cleanup-unavailable"])("browser enrollment regeneration succeeds via actual durable objects: %s", async mode => {
  const f = await fixture(), session = randomBase64Url(), csrf = randomBase64Url();
  const sessionHash = await sha256Hex(session), csrfHash = await sha256Hex(csrf);
  await runInDurableObject(f.registry, instance => {
    expect(instance.setupAdmin("synthetic-enrollment-admin", Date.now())).toBe(true);
    expect(instance.createAdminSession(sessionHash, csrfHash, Date.now() + 60000, Date.now(), 1)).toBe(true);
  });
  const registryBinding = {
    idFromName: () => env.REGISTRY.idFromName(f.runnerId),
    get: () => env.REGISTRY.get(env.REGISTRY.idFromName(f.runnerId)),
  } as unknown as typeof env.REGISTRY;
  await runInDurableObject(f.runner, async (_existing, state) => {
    const workerEnv = { ...env, REGISTRY: registryBinding }, target = await offlineRunner(state, f, workerEnv);
    target.registry.request = (runnerId, action, init) => requestRunnerRegistry(workerEnv, runnerId, action, init);
    let current = target.runner;
    const runnerBinding = {
      idFromName: env.RUNNER.idFromName.bind(env.RUNNER),
      get: () => ({ fetch: async (request: Request) => {
        if (new URL(request.url).pathname === "/cancel-policy-mutation") {
          if (mode === "cleanup-unavailable") return Response.json({ error: { code: "mutation_state_changed", message: "PRIVATE_UPSTREAM_SENTINEL" } }, { status: 409 });
          if (mode === "reconstructed") current = runnerRegistryFaults(state, workerEnv).runner;
        }
        return current.fetch(request);
      } }),
    } as unknown as typeof env.RUNNER;
    for (let attempt = 0; attempt < (mode === "cleanup-unavailable" ? 1 : 2); attempt++) {
      const response = await worker.fetch(new Request("https://worker.test/admin/runners/" + f.runnerId + "/enrollment", {
        method: "POST", headers: { origin: "https://worker.test", "content-type": "application/x-www-form-urlencoded",
          cookie: "__Host-runmesh_admin_session=" + session + "; __Host-runmesh_admin_csrf=" + csrf },
        body: new URLSearchParams({ csrf_token: csrf, expected_execution_mode: "dedicated_user", execution_mode: "dedicated_user" }),
      }), { ...workerEnv, RUNNER: runnerBinding }, {} as ExecutionContext);
      if (mode === "cleanup-unavailable") {
        expect(response.status).toBe(503);
        expect(response.headers.get("x-runmesh-error-code")).toBe("mutation_state_changed");
        expect(response.headers.get("x-runmesh-error-phase")).toBe("enrollment_fence_release");
        const text = await response.text();
        expect(text).toContain("Generate a new enrollment code to try again.");
        expect(text).not.toContain("PRIVATE_UPSTREAM_SENTINEL");
      } else {
        expect(response.status).toBe(200);
        expect(await response.text()).not.toContain("cleanup is uncertain");
      }
    }
    expect(await control(current, f.runnerId).admission()).toMatchObject({ fenced: true, reconciled: false,
      ...(mode === "cleanup-unavailable" ? { mutationPhase: "precommit" } : { mutationId: "restart-reconcile" }) });
  });
  await runInDurableObject(f.registry, (instance, state) => {
    expect(instance.getRunnerExecutionState(f.runnerId)!.runner.credential_version).toBe(3);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM runner_enrollments WHERE runner_id=? AND used_at_ms IS NULL", f.runnerId).one().n).toBe(1);
  });
});

it("a delayed cancellation cannot clear a newer mutation owner", async () => {
  const f = await fixture();
  await runInDurableObject(f.runner, async (_existing, state) => {
    const target = await offlineRunner(state, f);
    expect((await target.begin("old-owner")).status).toBe(204);
    target.registry.request = async () => {
      target.registry.request = f.route;
      // A second request releases the old fence and acquires a new owner
      // while the first cancellation is awaiting its Registry response.
      expect((await target.cancel("old-owner")).status).toBe(204);
      expect((await target.begin("new-owner")).status).toBe(204);
      return Response.json(f.proof);
    };
    expect((await target.cancel("old-owner")).status).toBe(409);
    expect(await target.admission()).toMatchObject({ fenced: true, mutationId: "new-owner" });
  });
});

it.each(["/admission-state", "/begin-policy-mutation", "/cancel-policy-mutation"])("rejects unsigned recovery requests: %s", async path => {
  const f = await fixture();
  await runInDurableObject(f.runner, async (_existing, state) => {
    const target = await offlineRunner(state, f);
    expect((await target.begin("signed-owner")).status).toBe(204);
    const response = await target.runner.fetch(new Request("https://runner.internal" + path, path === "/admission-state" ? {} : {
      method: "POST", body: JSON.stringify({ mutation_id: "signed-owner", runner_id: f.runnerId }),
    }));
    expect(response.status).toBe(404);
    expect(await target.admission()).toMatchObject({ fenced: true, mutationId: "signed-owner" });
  });
});
