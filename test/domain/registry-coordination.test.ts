import { expect, it, vi } from "vitest";
import { createRunnerHistoryRoutes, type RunnerHistoryPorts } from "../../apps/worker/src/registry/history-routes.js";
import { createRunnerLifecycleRoutes, type RunnerLifecyclePorts } from "../../apps/worker/src/registry/routes/runner-lifecycle.js";
import { createRunnerPolicyReadRoutes, type RunnerPolicyReadPorts } from "../../apps/worker/src/registry/routes/runner-policy-read.js";
import type { RunnerRouteRequest } from "../../apps/worker/src/registry/route-inputs.js";
import type { RunnerRow } from "../../apps/worker/src/registry/records.js";
import type { RunnerPolicy } from "@aloneio/runmesh-protocol";
import { PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { createRunnerTransportRoutes, type RunnerTransportPorts } from "../../apps/worker/src/registry/transport-routes.js";
import { DEFAULT_JOB_HISTORY } from "../../apps/worker/src/job-history-settings.js";

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
function syncRequest(sequence = 2, acknowledge = true) {
  return request("sync", "POST", {
    epoch: 1, credential_version: 1, now_ms: 123, lifecycle_id: "audit88-lifecycle", session_id: "audit88-session-id",
    message: { type: "runner.sync", protocol_version: PROTOCOL_CURRENT_VERSION, runner_id: "r",
      sync_sequence: sequence, sent_at_ms: 123, workspaces: [], jobs: [],
      ...(acknowledge ? { extensions: { runmesh_history_ack: true } } : {}) }
  });
}

it.each(["current", "replaced", "unavailable"] as const)("history settings use current lifecycle authority after %s persistence", async outcome => {
  const h = history();
  let settings = { ...DEFAULT_JOB_HISTORY, retention_days: 7 };
  const ports: RunnerHistoryPorts = { ...h.ports, setJobHistorySettings: () => true, jobHistorySettings: () => settings,
    packedJobs: { ...h.ports.packedJobs, setRetention: async (_id, _lifecycle, currentSettings) => {
      expect(currentSettings()).toEqual(settings);
      settings = { ...settings, retention_days: 1 };
      expect(currentSettings()).toEqual(settings);
      if (outcome === "replaced") { h.replace(); expect(currentSettings()).toBeUndefined(); }
      if (outcome === "unavailable") throw new Error("D1 unavailable");
    } } };
  const response = await createRunnerHistoryRoutes(ports)(request("history-settings", "POST", settings));
  expect(response?.status).toBe(outcome === "replaced" ? 409 : outcome === "unavailable" ? 202 : 200);
  if (outcome !== "replaced") expect(await response?.json()).toMatchObject({ retention_days: 1 });
});
function sqliteHistory(overrides: Partial<RunnerHistoryPorts> = {}) {
  const syncRunner = vi.fn(() => true);
  const ports: RunnerHistoryPorts = {
    ...history().ports, packedHistory: false, syncRunner,
    runnerRow: () => ({ ...runner("audit88-lifecycle"), state: "online", session_id: "audit88-session-id", last_sync_sequence: 1 }),
    runnerMatchesTransportFence: (current): current is RunnerRow => current?.session_id === "audit88-session-id",
    jobHistorySettings: () => DEFAULT_JOB_HISTORY, featureHealthDisabled: () => false,
    ...overrides
  };
  return { route: createRunnerHistoryRoutes(ports), syncRunner };
}
it.each([0, 1])("acknowledges superseded snapshot %s without disconnecting the current session", async sequence => {
  const h = sqliteHistory();
  const response = await h.route(syncRequest(sequence));
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ history_status: "unchanged" });
  expect(h.syncRunner).not.toHaveBeenCalled();
});
it("still rejects superseded snapshots from a replaced session", async () => {
  const h = sqliteHistory({ runnerRow: () => ({ ...runner(), session_id: "replacement", last_sync_sequence: 5 }) });
  expect((await h.route(syncRequest(1)))?.status).toBe(409);
  expect(h.syncRunner).not.toHaveBeenCalled();
});
it("acknowledges SQLite history persistence for batched reporting", async () => {
  const h = sqliteHistory();
  const response = await h.route(syncRequest());
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ history_status: "recorded" });
  expect(h.syncRunner).toHaveBeenCalledOnce();
});
it("does not report a degraded SQLite write as persisted", async () => {
  const h = sqliteHistory({ featureHealthDisabled: () => true });
  const response = await h.route(syncRequest());
  expect(response?.status).toBe(202);
  expect(await response?.json()).toEqual({ history_status: "degraded" });
});
it("honors disabled history with SQLite while keeping session validation", async () => {
  const h = sqliteHistory({ jobHistorySettings: () => ({ ...DEFAULT_JOB_HISTORY, mode: "off" }) });
  expect(await (await h.route(syncRequest()))?.json()).toEqual({ history_status: "disabled" });
  expect(h.syncRunner).not.toHaveBeenCalled();
});
it("keeps legacy sync acknowledgement empty", async () => {
  const h = sqliteHistory();
  const response = await h.route(syncRequest(2, false));
  expect(response?.status).toBe(204);
  expect(await response?.text()).toBe("");
});
it("negotiates batched job reporting independently of the history backend", async () => {
  const ports: RunnerTransportPorts = {
    authenticateRunner: unexpected, beginConnection: () => 1,
    runnerRow: () => ({ ...runner("audit88-lifecycle"), session_id: "audit88-session-id" }), desiredPolicy: () => undefined,
    scheduleMaintenanceAlarm: async () => {}, jobHistorySettings: () => DEFAULT_JOB_HISTORY,
    markDisconnected: unexpected
  };
  const route = createRunnerTransportRoutes(ports);
  const response = await route(request("connect", "POST", {
    session_id: "audit88-session-id", credential_version: 1, now_ms: 123,
    min_protocol_version: PROTOCOL_CURRENT_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
    metadata: { runner_id: "r", runner_version: "test", platform: "linux", architecture: "x64",
      capabilities: { filesystem: true, process_execution: true, workspace_sync: true, pty: false,
        network_access: false, max_concurrent_jobs: 2, supported_rpc_methods: ["exec.start"],
        labels: { job_history_protocol: "1", job_reporting_protocol: "2" } } }
  }));
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ job_history: DEFAULT_JOB_HISTORY, job_reporting: 2 });
});
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
