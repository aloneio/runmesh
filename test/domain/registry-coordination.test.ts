import { expect, it, vi } from "vitest";
import { createRunnerHistoryRoutes, type RunnerHistoryPorts } from "../../apps/worker/src/registry/history-routes.js";
import { createRunnerLifecycleRoutes, type RunnerLifecyclePorts } from "../../apps/worker/src/registry/routes/runner-lifecycle.js";
import { createRunnerPolicyReadRoutes, type RunnerPolicyReadPorts } from "../../apps/worker/src/registry/routes/runner-policy-read.js";
import type { RunnerRouteRequest } from "../../apps/worker/src/registry/route-inputs.js";
import type { RunnerRow } from "../../apps/worker/src/registry/records.js";
import type { RunnerPolicy } from "@aloneio/runmesh-protocol";

function unexpected(): never {
  throw new Error("unexpected route dependency");
}
function runner(lifecycleId = "old"): RunnerRow {
  return {
    runner_id: "r", display_name: "Runner", token_verifier: "a".repeat(64),
    state: "offline", connection_epoch: 1, credential_version: 1,
    lifecycle_id: lifecycleId, configured_execution_mode: "dedicated_user",
    session_id: null, metadata_json: null, public_info_json: null,
    last_heartbeat_ms: null, last_sync_sequence: null,
    desired_policy_revision: 4, desired_policy_checksum: null,
    applied_policy_revision: null, active_policy_checksum: null,
    runner_reported_policy_revision: null, runner_reported_policy_checksum: null,
    policy_status: "offline_pending", runner_permissions_json: "{}",
    current_runner_version: null, protocol_min_version: null, protocol_max_version: null,
    protocol_compatibility: "unknown", update_channel: "stable",
    desired_runner_version: null, latest_runner_version: null, update_status: "unknown",
    updated_at_ms: 123, valid_from_ms: null, valid_until_ms: null
  };
}
function lifecycle(overrides: Partial<RunnerLifecyclePorts>): RunnerLifecyclePorts {
  return {
    authorizeMcpRpc: unexpected, runnerRow: unexpected, registerRunner: unexpected,
    recordHeartbeat: unexpected, sessionIsCurrent: unexpected, addRunner: unexpected,
    deleteRunner: unexpected, renameRunner: unexpected, createRunnerEnrollment: unexpected,
    runnerAccess: unexpected, latestRunnerEnrollment: unexpected, setRunnerValidity: unexpected,
    invalidateRunnerCredential: unexpected, revokeRunner: unexpected,
    getRunnerMutationState: unexpected, getRunnerExecutionState: unexpected, getRunner: unexpected,
    ...overrides
  };
}
function policyRead(overrides: Partial<RunnerPolicyReadPorts>): RunnerPolicyReadPorts {
  return {
    getActivePolicySnapshot: unexpected, getSnapshotAuthorization: unexpected,
    getPolicyReadiness: unexpected, getRunner: unexpected,
    policyAcknowledgementFromInput: unexpected, desiredPolicy: unexpected,
    listPolicyVersions: unexpected, policyMutationId: unexpected,
    ...overrides
  };
}
const request = (action: string | undefined, method = "GET", input = {}): RunnerRouteRequest => ({
  method,
  runnerId: "r",
  action,
  itemId: undefined,
  input,
  nowMs: 123,
  url: new URL("https://registry.internal/runners/r/" + (action ?? ""))
});
function history() {
  let life = "old";
  const ports = {
    packedHistory: true,
    externalAuditing: true,
    runnerRow: () => runner(life),
    jobHistorySettings: () => ({
      mode: "batched" as const,
      retention_days: 7,
      interval_seconds: 900
    }),
    listJobs: vi.fn(() => []),
    listMcpCalls: vi.fn(() => []),
    setJobHistorySettings: unexpected, syncRunner: unexpected, sessionIsCurrent: unexpected,
    recordJobEvent: unexpected, featureHealthDisabled: unexpected, recordMcpCall: unexpected,
    recordsJobActivity: unexpected, getJob: unexpected, getMcpClient: unexpected,
    runnerMatchesTransportFence: (_current: RunnerRow | undefined): _current is RunnerRow => unexpected(),
    packedJobs: {
      merge: unexpected, get: unexpected, setRetention: unexpected,
      list: async () => ({
        jobs: [],
        updated_at_ms: null,
        retained_limit: 500
      })
    },
    externalAudit: {
      append: unexpected,
      list: async () => []
    }
  } satisfies RunnerHistoryPorts;
  return {
    ports,
    route: createRunnerHistoryRoutes(ports),
    replace: () => {
      life = "new";
    }
  };
}
it.each(["jobs", "mcp-calls"])("history %s rechecks lifecycle after the external read", async action => {
  const h = history();
  if (action === "jobs") h.ports.packedJobs.list = async () => {
    h.replace();
    return {
      jobs: [],
      updated_at_ms: null,
      retained_limit: 500
    };
  };else h.ports.externalAudit.list = async () => {
    h.replace();
    return [];
  };
  const response = await h.route(request(action));
  expect(response?.status).toBe(409);
  expect(h.ports.listMcpCalls).not.toHaveBeenCalled();
});
it.each(["jobs", "mcp-calls"])("history %s does not disguise an unavailable external store as empty success", async action => {
  const h = history();
  h.ports.packedJobs.list = async () => {
    throw new Error("quota");
  };
  h.ports.externalAudit.list = async () => {
    throw new Error("quota");
  };
  const response = await h.route(request(action));
  expect(response?.status).toBe(503);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(h.ports.listJobs).not.toHaveBeenCalled();
  expect(h.ports.listMcpCalls).not.toHaveBeenCalled();
});
it("lifecycle registration performs validation and mutation synchronously", () => {
  const registerRunner = vi.fn(() => true);
  const route = createRunnerLifecycleRoutes(lifecycle({
    runnerRow: () => undefined,
    registerRunner
  }));
  const response = route(request(undefined, "PUT", {
    token_verifier: "a".repeat(64),
    execution_mode: "dedicated_user"
  }));
  expect(response).toBeInstanceOf(Response);
  expect(response?.status).toBe(204);
  expect(registerRunner).toHaveBeenCalledWith("r", "a".repeat(64), 123, undefined, "dedicated_user");
});
it("credential replacement requires a mutation before entering the owner", () => {
  const registerRunner = vi.fn();
  const route = createRunnerLifecycleRoutes(lifecycle({
    runnerRow: () => runner(),
    registerRunner
  }));
  expect(route(request(undefined, "PUT", {
    token_verifier: "a".repeat(64)
  }))?.status).toBe(400);
  expect(registerRunner).not.toHaveBeenCalled();
});
it("desired-policy projection requests mutation evidence through the policy read model", async () => {
  const policyMutationId = vi.fn(() => "mutation");
  const policy: RunnerPolicy = {
    schema_version: 1, runner_id: "r", revision: 4, checksum: "a".repeat(64),
    runner_permissions: { read: false, edit: false, shell: false, job_control: false },
    workspaces: []
  };
  const route = createRunnerPolicyReadRoutes(policyRead({
    desiredPolicy: () => policy,
    policyMutationId
  }));
  const response = route(request("desired-policy"));
  expect(await response?.json()).toEqual({
    ...policy,
    mutation_id: "mutation"
  });
  expect(policyMutationId).toHaveBeenCalledWith("r", 4);
});
