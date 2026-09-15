import { json } from "../platform/control-plane.js";
import { record } from "../values.js";
import { registryGet } from "../platform/control-plane.js";
import { runnerConfiguredExecutionMode } from "../domain/execution-mode.js";
import type { RunnerExecutionSnapshotResult } from "../contracts/runner-admin.js";
import { runnerRegistryRequest } from "../platform/control-plane.js";
import { runnerRpc } from "../platform/control-plane.js";
import type { WorkerEnv } from "../platform/env.js";

/**
 * Read the Registry-owned mode together with the opaque lifecycle identity
 * used by transport fencing.  The Registry returns both from one Durable
 * Object turn so a delete/recreate cannot be interleaved between the two
 * values.  The ordinary Runner projection intentionally omits lifecycle_id;
 * this authenticated internal seam never exposes it to dashboard/MCP callers.
 */
export async function runnerExecutionSnapshot(env: WorkerEnv, runnerId: string): Promise<RunnerExecutionSnapshotResult> {
  let runnerResponse: Response;
  try { runnerResponse = await runnerRegistryRequest(env, runnerId, "/execution-state", "GET", ""); }
  catch { return { status: 503 }; }
  if (!runnerResponse.ok) return { status: runnerResponse.status };
  let body: Record<string, unknown> | undefined;
  try { body = record(await json(runnerResponse)); }
  catch { return { status: 502 }; }
  const runner = record(body?.runner);
  const lifecycleId = body?.lifecycle_id;
  if (runner === undefined || runner.runner_id !== runnerId || typeof lifecycleId !== "string" || lifecycleId.length === 0) return { status: 502 };
  return { status: 200, snapshot: { runner, configuredMode: runnerConfiguredExecutionMode(runner), lifecycleId } };
}

export async function policyReadiness(env: WorkerEnv, runnerId: string): Promise<{ ok: true; value: { applied_revision: number; active_checksum: string } } | { ok: false }> {
  let response: Response;
  try { response = await registryGet(env, `/runners/${encodeURIComponent(runnerId)}/policy-readiness`); } catch { return { ok: false }; }
  if (!response.ok) return { ok: false };
  const value = record(await json(response));
  const revision = value?.applied_revision;
  const checksum = value?.active_checksum;
  const validRevision = (candidate: unknown): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;
  const validChecksum = (candidate: unknown): candidate is string => typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
  return value?.ok === true && value.policy_status === "applied"
    && validRevision(value.desired_revision) && validRevision(revision) && validRevision(value.runner_reported_policy_revision)
    && validChecksum(value.desired_checksum) && validChecksum(checksum) && validChecksum(value.runner_reported_policy_checksum)
    && value.desired_revision === revision && value.runner_reported_policy_revision === revision
    && value.desired_checksum === checksum && value.runner_reported_policy_checksum === checksum
    ? { ok: true, value: { applied_revision: revision, active_checksum: checksum } } : { ok: false };
}

export async function runnerEnvironment(env: WorkerEnv, runnerId: string): Promise<Record<string, unknown> | undefined> {
  const readiness = await policyReadiness(env, runnerId);
  if (!readiness.ok) return undefined;
  let response: Response;
  try { response = await runnerRpc(env, runnerId, "env.info", {}, readiness.value.applied_revision, readiness.value.active_checksum); } catch { return undefined; }
  const body = response.ok ? record(await json(response)) : undefined;
  return record(body?.result);
}

export async function loadLiveJobs(env: WorkerEnv, runnerId: string, workspaceId: string, limit: number): Promise<Response> {
  const readiness = await policyReadiness(env,runnerId);
  if (!readiness.ok) return new Response("policy unavailable",{status:503});
  const response = await runnerRpc(env,runnerId,"job.list",{workspace_id:workspaceId,limit},readiness.value.applied_revision,readiness.value.active_checksum);
  const payload = response?.ok ? record(await json(response)) : undefined;
  const jobs = Array.isArray(payload?.result) ? payload.result : record(payload?.result)?.jobs;
  if (!Array.isArray(jobs) || jobs.some((job) => record(job)?.workspace_id !== workspaceId)) return new Response("live Jobs unavailable",{status:503});
  return Response.json({jobs:jobs.slice(0,limit),source:"runner_live"});
}
