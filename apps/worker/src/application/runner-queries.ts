import { record } from "../values.js";
import { runnerConfiguredExecutionMode } from "../domain/execution-mode.js";
import type { RunnerExecutionSnapshotResult } from "../contracts/runner-admin.js";
import type { RunnerQueryPorts } from "../contracts/control-plane-receipts.js";
import { appliedPolicyIdentity } from "../contracts/runner-selection.js";

/** Read mode and lifecycle from one observation, never two independently timed reads. */
export async function runnerExecutionSnapshot(ports: RunnerQueryPorts, runnerId: string): Promise<RunnerExecutionSnapshotResult> {
  const response = await ports.execution(runnerId).catch(() => undefined);
  if (response?.status !== 200) return { status: response?.status ?? 503 };
  const body = record(response.value), runner = record(body?.runner), lifecycleId = body?.lifecycle_id;
  if (runner === undefined || runner.runner_id !== runnerId || typeof lifecycleId !== "string" || lifecycleId.length === 0) return { status: 502 };
  return { status: 200, snapshot: { runner, configuredMode: runnerConfiguredExecutionMode(runner), lifecycleId } };
}

export async function policyReadiness(ports: RunnerQueryPorts, runnerId: string): Promise<{ ok: true; value: { applied_revision: number; active_checksum: string } } | { ok: false }> {
  const response = await ports.readiness(runnerId).catch(() => undefined);
  const value = response?.status === 200 ? appliedPolicyIdentity(response.value) : undefined;
  return value ? { ok: true, value } : { ok: false };
}

export async function runnerEnvironment(ports: RunnerQueryPorts, runnerId: string): Promise<Record<string, unknown> | undefined> {
  const readiness = await policyReadiness(ports, runnerId);
  if (!readiness.ok) return undefined;
  const response = await ports.rpc(runnerId, "env.info", {}, readiness.value.applied_revision, readiness.value.active_checksum).catch(() => undefined);
  return response?.status === 200 ? record(record(response.value)?.result) : undefined;
}

export async function loadLiveJobs(ports: RunnerQueryPorts, runnerId: string, workspaceId: string, limit: number): Promise<Record<string, unknown>[] | undefined> {
  const readiness = await policyReadiness(ports, runnerId);
  if (!readiness.ok) return undefined;
  const response = await ports.rpc(runnerId, "job.list", { workspace_id: workspaceId, limit }, readiness.value.applied_revision, readiness.value.active_checksum).catch(() => undefined);
  const payload = response?.status === 200 ? record(response.value) : undefined;
  const jobs = Array.isArray(payload?.result) ? payload.result : record(payload?.result)?.jobs;
  if (!Array.isArray(jobs)) return undefined;
  const rows = jobs.map(record);
  return rows.every((job): job is Record<string, unknown> => job !== undefined && job.workspace_id === workspaceId) ? rows.slice(0, limit) : undefined;
}
