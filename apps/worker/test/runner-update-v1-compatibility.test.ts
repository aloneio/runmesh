import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RunnerExactVersionSchema, RunnerUpdateClaimSchema, RunnerUpdateDrainProofSchema, RunnerUpdateOperationSchema, RunnerUpdateResponseSchema, RunnerUpdateStatusSchema } from "@aloneio/runmesh-protocol";
import { internalHeaders } from "../src/security.js";
import { maintenanceV1Claim, maintenanceV1Client, maintenanceV1DrainProof, maintenanceV1Error, maintenanceV1Operation, maintenanceV1Response, maintenanceV1State, maintenanceV1Status, type MaintenanceV1Operation } from "./fixtures/maintenance-v1-client.js";

const token = "remote-manager-test-token-0123456789abcdef";
const adminHeaders = { authorization: "Bearer test-admin-token-0123456789abcdef", "content-type": "application/json" };
const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
const originalVersion = "0.1.8-dev.45";
const targetVersion = "0.1.8-dev.46";
async function setup() {
  const runnerId = `v1:compat-${crypto.randomUUID()}`;
  const registered = await SELF.fetch("https://worker.test/admin/runners", { method: "POST", headers: adminHeaders,
    body: JSON.stringify({ runner_id: runnerId, token, execution_mode: "dedicated_user" }) });
  expect(registered.status).toBe(200);
  const lifecycleId = await runInDurableObject(registry(), (instance, state) => {
    // Seed the Registry's authenticated-session evidence, independently of the
    // candidate Runner's wire schema. The HTTP requests below use the real Worker.
    state.storage.sql.exec("UPDATE runners SET state = 'online', session_id = 'old-session', connection_epoch = 4, current_runner_version = ? WHERE runner_id = ?", originalVersion, runnerId);
    return instance.getRunnerExecutionState(runnerId)!.lifecycle_id;
  });
  const owner = { operation_id: crypto.randomUUID(), lifecycle_id: lifecycleId, manager_id: "released-manager-v1" };
  let currentToken = token;
  const client = maintenanceV1Client({ runnerId, token: () => currentToken, fetch: request => SELF.fetch(request) });
  const queue = async () => {
    const path = `/auth/runners/${encodeURIComponent(runnerId)}/update`;
    const body = JSON.stringify({ operation_id: owner.operation_id, expected_lifecycle_id: lifecycleId, update_channel: "pinned",
      target_version: targetVersion, target_channel: "dev", manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64) });
    const response = await registry().fetch(new Request(`https://registry.internal${path}`, { method: "POST",
      headers: await internalHeaders("test-internal-control-secret-not-for-production", "POST", path, body), body }));
    expect(response.status).toBe(200);
  };
  const raw = (suffix: string, body: unknown, requestToken = currentToken) => SELF.fetch(`https://worker.test/runner/${encodeURIComponent(runnerId)}/update${suffix}`, {
    method: "POST", headers: { authorization: `Bearer ${requestToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { runnerId, owner, client, queue, raw, rotate: (value: string) => { currentToken = value; } };
}

describe("released manager maintenance HTTP v1 compatibility", () => {
  it("keeps strict request and response shapes separate from ordinary Runner protocol evolution", () => {
    for (const [current, frozen] of [
      [RunnerUpdateClaimSchema, maintenanceV1Claim], [RunnerUpdateStatusSchema, maintenanceV1Status],
      [RunnerUpdateDrainProofSchema, maintenanceV1DrainProof], [RunnerUpdateOperationSchema, maintenanceV1Operation],
      [RunnerUpdateResponseSchema, maintenanceV1Response],
    ]) {
      expect(z.toJSONSchema(current!, { unrepresentable: "any" })).toEqual(z.toJSONSchema(frozen!, { unrepresentable: "any" }));
    }
    // Refinements cannot be represented in JSON Schema; preserve the exact
    // version grammar independently of the current release helper too.
    for (const version of ["0.1.7", "0.1.8-dev.45", "999999999.0.0-dev.99999999999999999999", "https://example.test/runner.tgz", "../runner", "01.2.3", "1.2.3-dev.01", "1.2.3-beta.1", "1.2.3+local", "1000000000.0.0", "1.2.3-dev.100000000000000000000"]) {
      expect(RunnerExactVersionSchema.safeParse(version).success).toBe(maintenanceV1Operation.shape.target_version.safeParse(version).success);
    }
  });

  it.each(["succeeded", "rolled_back", "failed"] as const)("serves the frozen old client through the real Worker through %s", async terminal => {
    const f = await setup();
    expect((await f.client.poll()).operation).toBeNull();
    await f.queue();
    expect((await f.client.poll()).operation).toMatchObject({ state: "queued", manager_id: null, target_version: targetVersion });
    await runInDurableObject(env.RUNNER.get(env.RUNNER.idFromName(f.runnerId)), async (_instance, state) => {
      // Persisted uncertainty represents an old Runner disconnect with an RPC
      // in flight. v1 must still be able to provide its stopped-process proof.
      await state.storage.put("runner-update-uncertain-rpc-v1", { [f.owner.lifecycle_id]: { lifecycle_id: f.owner.lifecycle_id, epoch: 4, session_id: "old-session" } });
    });
    expect(await f.client.claim(f.owner)).toMatchObject({ operation: { ...f.owner, state: "verifying" }, cloud_uncertain: true, cloud_drained: false });
    expect((await f.client.claim(f.owner)).operation?.state).toBe("verifying");
    expect((await f.client.report(f.owner, "draining")).operation?.state).toBe("draining");
    expect(await f.client.proveStopped(f.owner)).toMatchObject({ cloud_drained: true, cloud_uncertain: false });
    for (const progress of ["installing", "checking"] as const) expect((await f.client.report(f.owner, progress)).operation?.state).toBe(progress);
    const details = terminal === "succeeded" ? { observed_version: targetVersion } : { error_code: "activation_failed" as const };
    if (terminal !== "failed") {
      await expect(f.client.report(f.owner, terminal, details)).rejects.toThrow("maintenance_http_409");
      await runInDurableObject(registry(), (_instance, state) => {
        state.storage.sql.exec("UPDATE runners SET connection_epoch = 5, session_id = 'replacement-session', current_runner_version = ? WHERE runner_id = ?", terminal === "succeeded" ? targetVersion : originalVersion, f.runnerId);
      });
    }
    const completed = await f.client.report(f.owner, terminal, details);
    expect(completed.operation?.state).toBe(terminal);
    // The released client can retry a terminal POST after a lost acknowledgement.
    expect(await f.client.report(f.owner, terminal, details)).toEqual(completed);
    expect((await f.client.poll()).operation).toEqual(completed.operation);
    await runInDurableObject(env.RUNNER.get(env.RUNNER.idFromName(f.runnerId)), async (_instance, state) => {
      expect(await state.storage.get("runner-update-maintenance-v1")).toBeUndefined();
    });
  });

  it("reads every saved v1 state/error through the current storage reader and actual HTTP output", async () => {
    const f = await setup(); await f.queue();
    const queued = (await f.client.poll()).operation!;
    const cases: MaintenanceV1Operation[] = [
      ...maintenanceV1State.options.map(state => ({ ...queued, state, manager_id: state === "queued" ? null : f.owner.manager_id })),
      ...maintenanceV1Error.options.map(error_code => ({ ...queued, state: "failed" as const, manager_id: f.owner.manager_id, error_code })),
    ];
    for (const saved of cases) {
      await runInDurableObject(registry(), (_instance, state) => {
        state.storage.sql.exec("UPDATE runner_updates SET operation_json = ?, claim_epoch = 4 WHERE runner_id = ?", JSON.stringify(maintenanceV1Operation.parse(saved)), f.runnerId);
      });
      expect((await f.client.poll()).operation).toEqual(saved);
    }
  });

  it("keeps all v1 request routes strict and authorizes them with the current Runner credential", async () => {
    const f = await setup(); await f.queue();
    const malformed: [string, Record<string, unknown>][] = [
      ["/claim", { ...f.owner, protocol_version: 999 }],
      ["/status", { ...f.owner, state: "draining", capabilities: {} }],
      ["/status", { ...f.owner, state: "future-state" }],
      ["/status", { ...f.owner, state: "failed", error_code: "future-error" }],
      ["/drain-proof", { ...f.owner, old_process_stopped: true, runner_metadata: {} }],
      ["/drain-proof", { ...f.owner, old_process_stopped: false }],
      ["/claim", { operation_id: f.owner.operation_id, lifecycle_id: f.owner.lifecycle_id }],
    ];
    for (const [path, body] of malformed) expect((await f.raw(path, body)).status).toBe(400);
    for (const [path, body] of [["/claim", f.owner], ["/status", { ...f.owner, state: "draining" }], ["/drain-proof", { ...f.owner, old_process_stopped: true }]] as const) {
      expect((await f.raw(path, body, "invalid")).status).toBe(401);
    }
    expect((await f.raw("/claim", { ...f.owner, lifecycle_id: "stale-lifecycle" })).status).toBe(409);
    expect((await f.client.claim(f.owner)).operation?.state).toBe("verifying");
    expect((await f.raw("/claim", { ...f.owner, manager_id: "different-manager" })).status).toBe(409);
    const nextToken = "rotated-manager-test-token-0123456789abcdef";
    expect((await SELF.fetch(`https://worker.test/admin/runners/${encodeURIComponent(f.runnerId)}/rotate`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ token: nextToken }) })).status).toBe(200);
    await expect(f.client.poll()).rejects.toThrow("maintenance_http_401");
    f.rotate(nextToken);
    expect((await f.client.poll()).operation?.operation_id).toBe(f.owner.operation_id);
    expect((await f.client.report(f.owner, "failed", { error_code: "verification_failed" })).operation?.state).toBe("failed");
  });
});
