import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { RunnerExactVersionSchema, type RunnerUpdateResponse } from "@aloneio/runmesh-protocol";
import { internalHeaders, runnerTokenVerifier } from "../src/security.js";
import type { RegistryDO } from "../src/registry.js";
import { handleRunnerUpdate } from "../src/http/runner-update.js";
import type { WorkerEnv } from "../src/platform/env.js";
import { RunnerUpdateMaintenance } from "../src/platform/runner-update-maintenance.js";
import { maintenanceV1Response } from "./fixtures/maintenance-v1-client.js";

const secret = "test-internal-control-secret-not-for-production";
const token = "remote-manager-test-token-0123456789abcdef";
async function signed(path: string, input?: Record<string, unknown>): Promise<Request> {
  const body = input === undefined ? "" : JSON.stringify(input); const method = input === undefined ? "GET" : "POST";
  return new Request(`https://registry.internal${path}`, { method, headers: await internalHeaders(secret, method, path, body), ...(input === undefined ? {} : { body }) });
}
async function setup(instance: RegistryDO) {
  const runnerId = `upgrade-${crypto.randomUUID()}`;
  const verifier = await runnerTokenVerifier(token, "test-runner-token-pepper-not-for-production");
  expect(instance.registerRunner(runnerId, verifier, Date.now(), undefined, "dedicated_user")).toBe(true);
  const execution = instance.getRunnerExecutionState(runnerId)!;
  return { runnerId, lifecycleId: execution.lifecycle_id, credential: execution.runner.credential_version };
}
function createInput(lifecycleId: string, operationId = crypto.randomUUID()) {
  return { operation_id: operationId, expected_lifecycle_id: lifecycleId, update_channel: "pinned", target_version: "0.1.7-dev.42", target_channel: "dev", manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64) };
}
const scoped = () => env.REGISTRY.get(env.REGISTRY.idFromName(`upgrade-tests-${crypto.randomUUID()}`));

describe("independent Runner update control", () => {
  it("performs zero SQL writes for idle authentication and polling", async () => {
    await runInDurableObject(scoped(), async (instance, state) => {
      const { runnerId } = await setup(instance);
      const localEnv = { ...env, REGISTRY: { idFromName: env.REGISTRY.idFromName.bind(env.REGISTRY), get: () => ({ fetch: (request: Request) => instance.fetch(request) }) } } as unknown as WorkerEnv;
      const exec = state.storage.sql.exec.bind(state.storage.sql); let written = 0;
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => { const cursor = exec(query, ...args); written += cursor.rowsWritten; return cursor; });
      try {
        for (let n = 0; n < 20; n++) {
          const url = new URL(`https://worker.test/runner/${runnerId}/update`);
          const response = await handleRunnerUpdate(new Request(url, { headers: { authorization: `Bearer ${token}` } }), localEnv, url);
          expect(maintenanceV1Response.parse(await response.json())).toEqual({ operation: null, cloud_drained: false, cloud_uncertain: false, observed_version: null, observed_new_session: false });
        }
        expect(written).toBe(0);
      } finally { spy.mockRestore(); }
    });
  });

  it.each(["succeeded", "rolled_back", "failed", "rollback_failed"] as const)("keeps saved %s polling read-only without contacting RunnerDO", async terminal => {
    await runInDurableObject(scoped(), async (instance, state) => {
      const { runnerId, lifecycleId, credential } = await setup(instance); const create = createInput(lifecycleId);
      await instance.fetch(await signed(`/auth/runners/${runnerId}/update`, create));
      const claimed = await instance.fetch(await signed(`/runners/${runnerId}/update/claim`, { operation_id: create.operation_id, lifecycle_id: lifecycleId, manager_id: "manager-a", auth_lifecycle_id: lifecycleId, auth_credential_version: credential }));
      const operation = (await claimed.json() as RunnerUpdateResponse).operation!;
      const saved = { ...operation, state: terminal === "rollback_failed" ? "failed" : terminal, error_code: terminal === "rollback_failed" ? "rollback_failed" : null };
      state.storage.sql.exec("UPDATE runner_updates SET operation_json = ? WHERE runner_id = ?", JSON.stringify(saved), runnerId);
      const runnerFetch = vi.fn(() => { throw new Error("terminal GET must not contact RunnerDO"); });
      const localEnv = { ...env,
        REGISTRY: { idFromName: env.REGISTRY.idFromName.bind(env.REGISTRY), get: () => ({ fetch: (request: Request) => instance.fetch(request) }) },
        RUNNER: { idFromName: env.RUNNER.idFromName.bind(env.RUNNER), get: () => ({ fetch: runnerFetch }) },
      } as unknown as WorkerEnv;
      const exec = state.storage.sql.exec.bind(state.storage.sql); let written = 0;
      const sql = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => { const cursor = exec(query, ...args); written += cursor.rowsWritten; return cursor; });
      const put = vi.spyOn(state.storage, "put"), remove = vi.spyOn(state.storage, "delete");
      try {
        for (let n = 0; n < 20; n++) {
          const url = new URL(`https://worker.test/runner/${runnerId}/update`);
          const response = await handleRunnerUpdate(new Request(url, { headers: { authorization: `Bearer ${token}` } }), localEnv, url);
          expect(response.status).toBe(200); expect(maintenanceV1Response.parse(await response.json()).operation).toEqual(saved);
        }
        expect(runnerFetch).not.toHaveBeenCalled(); expect(written).toBe(0);
        expect(put).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
      } finally { sql.mockRestore(); put.mockRestore(); remove.mockRestore(); }
    });
  });

  it("retries a terminal status finalization after failure without relying on GET polling to release the fence", async () => {
    await runInDurableObject(scoped(), async (instance, state) => {
      const { runnerId, lifecycleId } = await setup(instance); const create = createInput(lifecycleId);
      await instance.fetch(await signed(`/auth/runners/${runnerId}/update`, create));
      const maintenance = new RunnerUpdateMaintenance({ storage: state.storage,
        registry: async (id, action) => instance.fetch(await signed(`/runners/${encodeURIComponent(id)}${action}`)),
        connections: () => [], pendingReplies: () => 0,
      });
      let failFinish = true;
      const runnerFetch = vi.fn(async (request: Request) => {
        if (new URL(request.url).pathname === "/update-maintenance/finish" && failFinish) return new Response("temporary finalization outage", { status: 503 });
        return maintenance.handle(request, await request.text());
      });
      const localEnv = { ...env,
        REGISTRY: { idFromName: env.REGISTRY.idFromName.bind(env.REGISTRY), get: () => ({ fetch: (request: Request) => instance.fetch(request) }) },
        RUNNER: { idFromName: env.RUNNER.idFromName.bind(env.RUNNER), get: () => ({ fetch: runnerFetch }) },
      } as unknown as WorkerEnv;
      const external = (action = "", payload?: Record<string, unknown>) => {
        const url = new URL(`https://worker.test/runner/${runnerId}/update${action}`);
        return handleRunnerUpdate(new Request(url, { method: payload === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), localEnv, url);
      };
      const owner = { operation_id: create.operation_id, lifecycle_id: lifecycleId, manager_id: "manager-a" };
      expect((await external("/claim", owner)).status).toBe(200); expect(maintenance.blocksLifecycle(lifecycleId)).toBe(true);
      const terminal = { ...owner, state: "failed", error_code: "verification_failed" };
      expect((await external("/status", terminal)).status).toBe(503); expect(maintenance.blocksLifecycle(lifecycleId)).toBe(true);
      runnerFetch.mockClear();
      const polled = await external(); expect((await polled.json() as RunnerUpdateResponse).operation?.state).toBe("failed");
      expect(runnerFetch).not.toHaveBeenCalled(); expect(maintenance.blocksLifecycle(lifecycleId)).toBe(true);
      failFinish = false;
      const retried = await external("/status", terminal); expect(retried.status).toBe(200);
      expect((await retried.json() as RunnerUpdateResponse).operation?.state).toBe("failed"); expect(maintenance.blocksLifecycle(lifecycleId)).toBe(false);
      // Replaying again after a lost successful acknowledgement is harmless.
      expect((await external("/status", terminal)).status).toBe(200); expect(maintenance.blocksLifecycle(lifecycleId)).toBe(false);
    });
  });

  it("binds requests to lifecycle, request identity, release hashes and a single manager", async () => {
    await runInDurableObject(scoped(), async instance => {
      const { runnerId, lifecycleId, credential } = await setup(instance);
      const create = createInput(lifecycleId);
      const path = `/auth/runners/${runnerId}/update`;
      expect((await instance.fetch(await signed(path, create))).status).toBe(200);
      expect((await instance.fetch(await signed(path, create))).status).toBe(200);
      expect((await instance.fetch(await signed(path, { ...create, artifact_sha256: "c".repeat(64) }))).status).toBe(409);
      expect((await instance.fetch(await signed(path, createInput(lifecycleId)))).status).toBe(409);
      const claim = { operation_id: create.operation_id, lifecycle_id: lifecycleId, manager_id: "manager-a", auth_lifecycle_id: lifecycleId, auth_credential_version: credential };
      const claimed = await instance.fetch(await signed(`/runners/${runnerId}/update/claim`, claim));
      expect(claimed.status).toBe(200);
      expect((await claimed.json() as RunnerUpdateResponse).operation?.state).toBe("verifying");
      expect((await instance.fetch(await signed(`/runners/${runnerId}/update/claim`, { ...claim, manager_id: "manager-b" }))).status).toBe(409);
      expect((await instance.fetch(await signed(`/runners/${runnerId}/update/claim`, { ...claim, auth_credential_version: credential + 1 }))).status).toBe(401);
      expect((await instance.fetch(await signed(`/runners/${runnerId}/update?lifecycle_id=stale&credential_version=${credential}`))).status).toBe(401);
    });
  });

  it("deduplicates claims and progress writes and requires a fresh authenticated target session", async () => {
    await runInDurableObject(scoped(), async (instance, state) => {
      const { runnerId, lifecycleId, credential } = await setup(instance);
      state.storage.sql.exec("UPDATE runners SET current_runner_version = '0.1.7', state = 'online', session_id = 'original', connection_epoch = 4 WHERE runner_id = ?", runnerId);
      const create = createInput(lifecycleId);
      expect((await instance.fetch(await signed(`/auth/runners/${runnerId}/update`, create))).status).toBe(200);
      const claim = { operation_id: create.operation_id, lifecycle_id: lifecycleId, manager_id: "manager-a", auth_lifecycle_id: lifecycleId, auth_credential_version: credential };
      expect((await instance.fetch(await signed(`/runners/${runnerId}/update/claim`, claim))).status).toBe(200);
      const exec = state.storage.sql.exec.bind(state.storage.sql); let written = 0;
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((query: string, ...args: any[]) => { const cursor = exec(query, ...args); written += cursor.rowsWritten; return cursor; });
      try {
        for (let n = 0; n < 5; n++) {
          expect((await instance.fetch(await signed(`/runners/${runnerId}/update/claim`, claim))).status).toBe(200);
          expect((await instance.fetch(await signed(`/runners/${runnerId}/update/status`, { ...claim, state: "verifying" }))).status).toBe(200);
        }
        expect(written).toBe(0);
      } finally { spy.mockRestore(); }
      for (const progress of ["draining", "installing", "checking"]) expect((await instance.fetch(await signed(`/runners/${runnerId}/update/status`, { ...claim, state: progress }))).status).toBe(200);
      const success = { ...claim, state: "succeeded", observed_version: create.target_version };
      expect((await instance.fetch(await signed(`/runners/${runnerId}/update/status`, success))).status).toBe(409);
      state.storage.sql.exec("UPDATE runners SET current_runner_version = ?, connection_epoch = 5, session_id = 'replacement' WHERE runner_id = ?", create.target_version, runnerId);
      const terminal = await instance.fetch(await signed(`/runners/${runnerId}/update/status`, success));
      expect(terminal.status).toBe(200);
      expect((await terminal.json() as RunnerUpdateResponse).operation?.state).toBe("succeeded");
      expect((await instance.fetch(await signed(`/runners/${runnerId}/update/status`, success))).status).toBe(200);
      const next = createInput(lifecycleId); expect((await instance.fetch(await signed(`/auth/runners/${runnerId}/update`, next))).status).toBe(200);
      expect((await instance.fetch(await signed(`/runners/${runnerId}/update/status`, success))).status).toBe(409);
      expect((await instance.fetch(await signed(`/auth/runners/${runnerId}/update`, create))).status).toBe(409);
    });
  });

  it("rejects invalid external tokens and accepts an existing Runner credential without WebSocket features", async () => {
    const id = `external:update-${crypto.randomUUID()}`;
    const registered = await SELF.fetch("https://worker.test/admin/runners", { method: "POST", headers: { Authorization: "Bearer test-admin-token-0123456789abcdef", "content-type": "application/json" }, body: JSON.stringify({ runner_id: id, token, execution_mode: "dedicated_user" }) });
    expect(registered.status).toBe(200);
    expect((await SELF.fetch(`https://worker.test/runner/${encodeURIComponent(id)}/update`, { headers: { Authorization: "Bearer invalid" } })).status).toBe(401);
    const polled = await SELF.fetch(`https://worker.test/runner/${encodeURIComponent(id)}/update`, { headers: { Authorization: `Bearer ${token}` } });
    expect(polled.status).toBe(200); expect((await polled.json() as RunnerUpdateResponse).operation).toBeNull();
  });

  it("accepts only trusted canonical stable and development versions", () => {
    for (const version of ["0.1.7", "1.2.3-dev.42"]) expect(RunnerExactVersionSchema.safeParse(version).success).toBe(true);
    for (const version of ["https://example.test/a", "../a", "01.2.3", "1.2.3-beta.1", "1.2.3+local", "1.2.3-dev.01"]) expect(RunnerExactVersionSchema.safeParse(version).success).toBe(false);
  });

  it("isolates replacement lifecycles and rejects reuse of an older lifecycle request", async () => {
    await runInDurableObject(scoped(), async (instance, state) => {
      const { runnerId, lifecycleId, credential } = await setup(instance); const create = createInput(lifecycleId);
      expect((await instance.fetch(await signed(`/auth/runners/${runnerId}/update`, create))).status).toBe(200);
      const nextLifecycle = "f".repeat(64);
      state.storage.sql.exec("UPDATE runners SET lifecycle_id = ?, credential_version = credential_version + 1 WHERE runner_id = ?", nextLifecycle, runnerId);
      expect((await instance.fetch(await signed(`/runners/${runnerId}/update?lifecycle_id=${lifecycleId}&credential_version=${credential}`))).status).toBe(401);
      const current = await instance.fetch(await signed(`/runners/${runnerId}/update?lifecycle_id=${nextLifecycle}&credential_version=${credential + 1}`));
      expect((await current.json() as RunnerUpdateResponse).operation).toBeNull();
      expect((await instance.fetch(await signed(`/auth/runners/${runnerId}/update`, { ...create, expected_lifecycle_id: nextLifecycle }))).status).toBe(409);
      expect((await instance.fetch(await signed(`/auth/runners/${runnerId}/update`, createInput(nextLifecycle)))).status).toBe(200);
    });
  });

  it("requires a new original-version connection for rollback and retains rollback-failed recovery ownership", async () => {
    await runInDurableObject(scoped(), async (instance, state) => {
      const { runnerId, lifecycleId, credential } = await setup(instance); const create = createInput(lifecycleId);
      state.storage.sql.exec("UPDATE runners SET current_runner_version = '0.1.7', state = 'online', session_id = 'old', connection_epoch = 4 WHERE runner_id = ?", runnerId);
      await instance.fetch(await signed(`/auth/runners/${runnerId}/update`, create));
      const claim = { operation_id: create.operation_id, lifecycle_id: lifecycleId, manager_id: "manager-a", auth_lifecycle_id: lifecycleId, auth_credential_version: credential };
      await instance.fetch(await signed(`/runners/${runnerId}/update/claim`, claim));
      for (const progress of ["draining", "installing", "checking"]) await instance.fetch(await signed(`/runners/${runnerId}/update/status`, { ...claim, state: progress }));
      const rollback = { ...claim, state: "rolled_back", error_code: "activation_failed" };
      expect((await instance.fetch(await signed(`/runners/${runnerId}/update/status`, rollback))).status).toBe(409);
      state.storage.sql.exec("UPDATE runners SET connection_epoch = 5, session_id = 'restored' WHERE runner_id = ?", runnerId);
      expect((await instance.fetch(await signed(`/runners/${runnerId}/update/status`, rollback))).status).toBe(200);
      const next = createInput(lifecycleId);
      await instance.fetch(await signed(`/auth/runners/${runnerId}/update`, next));
      const nextClaim = { ...claim, operation_id: next.operation_id };
      await instance.fetch(await signed(`/runners/${runnerId}/update/claim`, nextClaim));
      expect((await instance.fetch(await signed(`/runners/${runnerId}/update/status`, { ...nextClaim, state: "failed", error_code: "rollback_failed" }))).status).toBe(200);
      expect((await instance.fetch(await signed(`/auth/runners/${runnerId}/update`, createInput(lifecycleId)))).status).toBe(409);
    });
  });
});
