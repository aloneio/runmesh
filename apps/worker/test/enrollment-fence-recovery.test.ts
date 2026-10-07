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
    finalize: (mutationId: string) => request("/revoke", { mutation_id: mutationId }),
    admission: async () => {
      const response = await request("/admission-state");
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, unknown>>;
    },
  };
}

/** Establish and reconcile through the existing handshake/socket port fixture. */
async function onlineRunner(state: DurableObjectState, f: Awaited<ReturnType<typeof fixture>>, workerEnv = env) {
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
  return { ...session, ...api };
}

/** Deliver the close event without assigning private admission state. */
async function offlineRunner(state: DurableObjectState, f: Awaited<ReturnType<typeof fixture>>, workerEnv = env) {
  const target = await onlineRunner(state, f, workerEnv);
  await target.disconnect();
  target.registry.request = f.route;
  expect(await target.admission()).toMatchObject({ sessionId: "session-test", connectionEpoch: 7, credentialVersion: 3 });
  return target;
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

it.each(["warm", "reconstructed", "cleanup-unavailable", "cleanup-oversized", "cleanup-retry", "cleanup-retry-reconstructed", "issuance-unknown", "issuance-response-lost"])("browser enrollment regeneration preserves recovery evidence via actual durable objects: %s", async mode => {
  const f = await fixture(), session = randomBase64Url(), csrf = randomBase64Url();
  const sessionHash = await sha256Hex(session), csrfHash = await sha256Hex(csrf);
  await runInDurableObject(f.registry, instance => {
    expect(instance.setupAdmin("synthetic-enrollment-admin", Date.now())).toBe(true);
    expect(instance.createAdminSession(sessionHash, csrfHash, Date.now() + 60000, Date.now(), 1)).toBe(true);
  });
  let issuanceFailed = false;
  const registryBinding = {
    idFromName: () => env.REGISTRY.idFromName(f.runnerId),
    get: () => {
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName(f.runnerId));
      return { fetch: async (request: Request) => {
        if (mode.startsWith("issuance-") && !issuanceFailed && request.method === "POST" && new URL(request.url).pathname.endsWith("/enrollments")) {
          issuanceFailed = true;
          if (mode === "issuance-response-lost") {
            const committed = await registry.fetch(request);
            expect(committed.status).toBe(200);
            await committed.body?.cancel();
          }
          return new Response(null, { status: 503 });
        }
        return registry.fetch(request);
      } };
    },
  } as unknown as typeof env.REGISTRY;
  await runInDurableObject(f.runner, async (_existing, state) => {
    const workerEnv = { ...env, REGISTRY: registryBinding }, target = await offlineRunner(state, f, workerEnv);
    target.registry.request = (runnerId, action, init) => requestRunnerRegistry(workerEnv, runnerId, action, init);
    let current = target.runner;
    let cleanupFailed = false;
    const runnerBinding = {
      idFromName: env.RUNNER.idFromName.bind(env.RUNNER),
      get: () => ({ fetch: async (request: Request) => {
        if (mode === "cleanup-retry-reconstructed" && cleanupFailed && new URL(request.url).pathname === "/begin-policy-mutation") current = runnerRegistryFaults(state, workerEnv).runner;
        if (new URL(request.url).pathname === "/cancel-policy-mutation") {
          if (mode === "cleanup-unavailable" || mode === "cleanup-oversized" || (mode.startsWith("cleanup-retry") && !cleanupFailed)) {
            cleanupFailed = true;
            return Response.json({ error: { code: "mutation_state_changed", message: "PRIVATE_UPSTREAM_SENTINEL" }, ...(mode === "cleanup-oversized" ? { padding: "x".repeat(32_768) } : {}) }, { status: 409 });
          }
          if (mode === "reconstructed") current = runnerRegistryFaults(state, workerEnv).runner;
        }
        return current.fetch(request);
      } }),
    } as unknown as typeof env.RUNNER;
    for (let attempt = 0; attempt < (mode === "cleanup-unavailable" || mode === "cleanup-oversized" ? 1 : 2); attempt++) {
      const response = await worker.fetch(new Request("https://worker.test/admin/runners/" + f.runnerId + "/enrollment", {
        method: "POST", headers: { origin: "https://worker.test", "content-type": "application/x-www-form-urlencoded",
          cookie: "__Host-runmesh_admin_session=" + session + "; __Host-runmesh_admin_csrf=" + csrf },
        body: new URLSearchParams({ csrf_token: csrf, expected_execution_mode: "dedicated_user", execution_mode: "dedicated_user" }),
      }), { ...workerEnv, RUNNER: runnerBinding }, {} as ExecutionContext);
      if (mode === "issuance-unknown" || (mode === "issuance-response-lost" && attempt === 0)) {
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('<code class="mono" data-no-i18n>');
      } else if (mode === "cleanup-unavailable" || mode === "cleanup-oversized" || (mode.startsWith("cleanup-retry") && attempt === 0)) {
        expect(response.status).toBe(503);
        expect(response.headers.get("x-runmesh-error-code")).toBe(mode === "cleanup-oversized" ? "cleanup_unavailable" : "mutation_state_changed");
        expect(response.headers.get("x-runmesh-error-phase")).toBe("enrollment_fence_release");
        const text = await response.text();
        expect(text).toContain("Generate a new enrollment code to try again.");
        expect(text).not.toContain("PRIVATE_UPSTREAM_SENTINEL");
        expect(text).not.toContain('<code class="mono" data-no-i18n>');
      } else {
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain("cleanup is uncertain");
        expect(text).toContain('<code class="mono" data-no-i18n>');
      }
    }
    expect(await control(current, f.runnerId).admission()).toMatchObject({ fenced: true, reconciled: false,
      ...(mode === "cleanup-unavailable" || mode === "cleanup-oversized" || mode === "issuance-unknown" ? { mutationPhase: "precommit" } : { mutationId: "restart-reconcile" }) });
  });
  await runInDurableObject(f.registry, (instance, state) => {
    expect(instance.getRunnerExecutionState(f.runnerId)!.runner.credential_version).toBe(3);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM runner_enrollments WHERE runner_id=? AND used_at_ms IS NULL", f.runnerId).one().n).toBe(mode === "issuance-unknown" ? 0 : 1);
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

it("records enrollment completion atomically and rejects delayed issuance replay", async () => {
  const f = await fixture();
  await runInDurableObject(f.registry, instance => {
    const issue = (id: string, verifier: string, mutation: string) => instance.createRunnerEnrollment(f.runnerId, id.repeat(43), verifier.repeat(64), Date.now(), undefined, false, "dedicated_user", f.lifecycleId, undefined, {}, mutation);
    expect(issue("a", "b", "enrollment-first")).toBeDefined();
    expect(instance.getRunnerMutationState(f.runnerId, "enrollment-first")).toMatchObject({
      mutation_committed: true, enrollment_mutation_committed: true,
      credential_mutation_committed: false, credential_mutation_kind: null, credential_version: 3,
    });
    expect(issue("c", "d", "enrollment-second")).toBeDefined();
    expect(issue("e", "f", "enrollment-first")).toBeUndefined();
    expect(instance.latestRunnerEnrollment(f.runnerId)?.enrollment_id).toBe("c".repeat(43));
    expect(instance.lookupRunnerEnrollment("d".repeat(64), Date.now())).toEqual({ runner_id: f.runnerId });
    expect(instance.lookupRunnerEnrollment("f".repeat(64), Date.now())).toBeUndefined();
  });
});

it("rolls back an enrollment receipt and mode selection when code insertion fails", async () => {
  const f = await fixture();
  await runInDurableObject(f.registry, instance => {
    const now = Date.now(), other = "enrollment-conflict-" + crypto.randomUUID();
    expect(instance.registerRunner(other, "b".repeat(64), now, undefined, "dedicated_user")).toBe(true);
    expect(instance.createRunnerEnrollment(other, "x".repeat(43), "a".repeat(64), now)).toBeDefined();
    expect(instance.createRunnerEnrollment(f.runnerId, "y".repeat(43), "b".repeat(64), now)).toBeDefined();
    // This primary-key conflict occurs after the receipt insert, mode update,
    // and old-code deletion inside the transaction.
    expect(instance.createRunnerEnrollment(f.runnerId, "x".repeat(43), "c".repeat(64), now, "privileged_host", true, "dedicated_user", f.lifecycleId, undefined, {}, "enrollment-rollback")).toBeUndefined();
    expect(instance.getRunnerMutationState(f.runnerId, "enrollment-rollback")).toMatchObject({ mutation_committed: false, enrollment_mutation_committed: false });
    expect(instance.getRunner(f.runnerId)?.configured_execution_mode).toBe("dedicated_user");
    expect(instance.latestRunnerEnrollment(f.runnerId)?.enrollment_id).toBe("y".repeat(43));
    expect(instance.lookupRunnerEnrollment("b".repeat(64), now)).toEqual({ runner_id: f.runnerId });
  });
});

it.each(["credential", "lifecycle"])("does not reuse an enrollment receipt after its %s changes", async change => {
  const f = await fixture();
  await runInDurableObject(f.registry, (instance, state) => {
    const now = Date.now(), mutation = "enrollment-old-identity";
    expect(instance.createRunnerEnrollment(f.runnerId, "a".repeat(43), "b".repeat(64), now, undefined, false, "dedicated_user", f.lifecycleId, undefined, {}, mutation)).toBeDefined();
    if (change === "credential") {
      expect(instance.invalidateRunnerCredential(f.runnerId, now, "replace-credential")).toBe(true);
    } else {
      expect(instance.deleteRunner(f.runnerId, f.runnerId, now, "delete-lifecycle")).toBe(true);
      expect(instance.getRunnerMutationState(f.runnerId, mutation)).toMatchObject({ runner_exists: false, mutation_committed: false, enrollment_mutation_committed: false });
      expect(instance.registerRunner(f.runnerId, "c".repeat(64), now, undefined, "dedicated_user")).toBe(true);
      // An equal generation in a different lifecycle must not match either.
      state.storage.sql.exec("UPDATE runners SET credential_version=3 WHERE runner_id=?", f.runnerId);
      expect(instance.getRunnerExecutionState(f.runnerId)!.lifecycle_id).not.toBe(f.lifecycleId);
    }
    expect(instance.getRunnerMutationState(f.runnerId, mutation)).toMatchObject({ mutation_committed: false, enrollment_mutation_committed: false, credential_mutation_committed: false });
    expect(instance.createRunnerEnrollment(f.runnerId, "d".repeat(43), "e".repeat(64), now, undefined, false, undefined, undefined, undefined, {}, mutation)).toBeUndefined();
  });
});

it("rejects malformed enrollment mutation IDs and permits issuance owned by creation or rotation", async () => {
  const f = await fixture();
  await runInDurableObject(f.registry, async (instance, state) => {
    const path = "/runners/" + f.runnerId + "/enrollments";
    const submit = async (extra: Record<string, unknown>) => {
      const body = JSON.stringify({ enrollment_id: "a".repeat(43), verifier: "b".repeat(64), ...extra });
      return instance.fetch(new Request("https://registry.internal" + path, { method: "POST", headers: await internalHeaders(env.INTERNAL_CONTROL_SECRET, "POST", path, body), body }));
    };
    for (const mutation_id of [null, "", "bad mutation", 42, {}, "a".repeat(129)]) {
      expect((await submit({ mutation_id })).status).toBe(400);
      expect(instance.latestRunnerEnrollment(f.runnerId)).toBeUndefined();
    }
    // Creation and rotation retain their separate credential-mutation owner.
    expect((await submit({})).status).toBe(200);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM runner_mutations WHERE runner_id=?", f.runnerId).one().n).toBe(0);
  });
});

it("an enrollment receipt cannot authorize credential finalization", async () => {
  const f = await fixture(), mutation = "enrollment-not-credential";
  const proof = await runInDurableObject(f.registry, instance => {
    expect(instance.createRunnerEnrollment(f.runnerId, "a".repeat(43), "b".repeat(64), Date.now(), undefined, false, "dedicated_user", f.lifecycleId, undefined, {}, mutation)).toBeDefined();
    return instance.getRunnerMutationState(f.runnerId, mutation);
  });
  await runInDurableObject(f.runner, async (_existing, state) => {
    const target = await offlineRunner(state, f);
    target.registry.request = async () => Response.json(proof);
    expect((await target.begin(mutation)).status).toBe(204);
    expect((await target.finalize(mutation)).status).toBe(409);
    expect(await target.admission()).toMatchObject({ fenced: true, mutationId: mutation, mutationPhase: "precommit" });
  });
});

it("a delayed enrollment recovery cannot release a newer owner", async () => {
  const f = await fixture(), mutation = "enrollment-delayed-recovery";
  const proof = await runInDurableObject(f.registry, instance => {
    expect(instance.createRunnerEnrollment(f.runnerId, "a".repeat(43), "b".repeat(64), Date.now(), undefined, false, "dedicated_user", f.lifecycleId, undefined, {}, mutation)).toBeDefined();
    return instance.getRunnerMutationState(f.runnerId, mutation);
  });
  await runInDurableObject(f.runner, async (_existing, state) => {
    const target = await offlineRunner(state, f);
    expect((await target.begin(mutation)).status).toBe(204);
    target.registry.request = async () => {
      target.registry.request = async (_runnerId, action) => action.includes(mutation) ? Response.json(proof) : f.route(_runnerId, action);
      expect((await target.cancel(mutation)).status).toBe(204);
      expect((await target.begin("new-enrollment-owner")).status).toBe(204);
      return Response.json(proof);
    };
    expect((await target.begin("delayed-competitor")).status).toBe(409);
    expect(await target.admission()).toMatchObject({ fenced: true, mutationId: "new-enrollment-owner", mutationPhase: "precommit" });
  });
});

it("recovers a completed enrollment while preserving the live applied session", async () => {
  const f = await fixture(), mutation = "enrollment-live-recovery";
  const proof = await runInDurableObject(f.registry, instance => {
    expect(instance.createRunnerEnrollment(f.runnerId, "a".repeat(43), "b".repeat(64), Date.now(), undefined, false, "dedicated_user", f.lifecycleId, undefined, {}, mutation)).toBeDefined();
    return instance.getRunnerMutationState(f.runnerId, mutation);
  });
  await runInDurableObject(f.runner, async (_existing, state) => {
    const target = await onlineRunner(state, f), request = target.registry.request;
    target.registry.request = async (runnerId, action, init) => action.includes("/mutation-state?")
      ? Response.json({ ...(action.includes(mutation) ? proof : f.proof), runner_state: "online", session_id: "session-test" })
      : request(runnerId, action, init);
    expect((await target.begin(mutation)).status).toBe(204);
    expect((await target.begin("enrollment-next-live-owner")).status).toBe(204);
    // A fresh pre-mutation baseline is captured only from restored live admission.
    expect(await target.admission()).toMatchObject({ mutationId: "enrollment-next-live-owner",
      preMutationActiveRevision: f.policy.revision, preMutationActiveChecksum: f.policy.checksum });
    expect((await target.cancel("enrollment-next-live-owner")).status).toBe(204);
    expect(await target.admission()).toMatchObject({ fenced: false, reconciled: true, mutationId: null,
      activeRevision: f.policy.revision, activeChecksum: f.policy.checksum, sessionId: "session-test" });
    expect(target.socket.close).not.toHaveBeenCalled();
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
