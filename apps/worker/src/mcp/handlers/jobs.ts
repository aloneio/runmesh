import { asToolResult } from "../results/envelope.js";
import { boundedReadParams } from "../request-values.js";
import { callRunner } from "../transport.js";
import { checkAnyReadPermission } from "../authorization.js";
import { checkPermission } from "../authorization.js";
import { fail } from "../results/envelope.js";
import { failWithDetails } from "../results/envelope.js";
import { failure } from "../results/envelope.js";
import { hintFor } from "../results/envelope.js";
import { isRecord } from "../results/primitives.js";
import { isSafeIdentifier } from "../../security.js";
import { JobInputSchema } from "../catalog.js";
import { MCP_RPC_ACTIONS } from "../actions.js";
import type { McpRequestEnv } from "../contracts.js";
import type { PermissionBit } from "../contracts.js";
import { policyReadiness } from "../authorization.js";
import { projectRunnerResult } from "../results/project.js";
import { recordRunnerToolCall } from "../audit.js";
import { registryCall } from "../transport.js";
import { registryJobsPath } from "../transport.js";
import { resolveActiveRunner } from "../selection.js";
import { rpcOperation } from "@aloneio/runmesh-protocol";
import { runnerFailure } from "../results/envelope.js";
import { runnerJobResultMatches } from "../results/jobs.js";
import type { RunnerResultMode } from "../contracts.js";
import { runnerSuccess } from "../results/envelope.js";
import { safeJobIdentifier } from "../results/primitives.js";
import { safeJobMetadata } from "../results/jobs.js";
import type { ToolCall } from "../contracts.js";
import { withAuditReceipt } from "../audit.js";
import { z } from "zod";

export async function jobTool(env: McpRequestEnv, clientId: string, params: z.output<typeof JobInputSchema>, scopes: readonly string[]): Promise<unknown> {
  const requirement = rpcOperation(MCP_RPC_ACTIONS.job[params.action])!;
  if (!scopes.includes(requirement.scope)) return failure("insufficient_scope", `This job action requires ${requirement.scope}.`, `Authorize the MCP client again with ${requirement.scope}.`);
  switch (params.action) {
    case "list":
      return activeJobList(env, clientId, params);
    case "get":
      return activeJobGet(env, clientId, params.job_id, params.workspace_id);
    case "logs":
      return activeJobRunnerTool(env, clientId, MCP_RPC_ACTIONS.job.logs, boundedReadParams(params, 16 * 1024), "read", "logs");
    case "cancel":
      return activeJobRunnerTool(env, clientId, MCP_RPC_ACTIONS.job.cancel, params, "job_control", "job");
    case "input":
      return activeJobRunnerTool(env, clientId, MCP_RPC_ACTIONS.job.input, params, "job_control", "input");
  }
}

async function activeJobRunnerTool(env: McpRequestEnv, clientId: string, method: string, params: Record<string, unknown>, requiredPermission: PermissionBit, resultMode: RunnerResultMode = "raw"): Promise<unknown> {
  const selected = await resolveActiveRunner(env, clientId);
  if (!selected.ok) return asToolResult(selected);
  const workspaceBound = typeof params.workspace_id === "string";
  const job: ToolCall = workspaceBound ? { ok: true, value: { workspace_id: params.workspace_id } }
    : await jobSnapshot(env, selected.value.runnerId, String(params.job_id));
  if (!job.ok) return runnerFailure(job.error, selected.value);
  const workspaceId = isRecord(job.value) && typeof job.value.workspace_id === "string" ? job.value.workspace_id : undefined;
  const requestedJobId = typeof params.job_id === "string" ? params.job_id : undefined;
  if (requestedJobId === undefined || workspaceId === undefined || !isSafeIdentifier(workspaceId)) {
    return runnerFailure(fail("permission_denied", "The operation is not permitted for this job.", "Use a job identifier belonging to an authorized workspace.").error, selected.value);
  }
  const permission = await checkPermission(env, clientId, selected.value.runnerId, workspaceId, requiredPermission);
  if (permission !== undefined) return asToolResult(permission);
  const readiness = await policyReadiness(env, selected.value.runnerId);
  if (!readiness.ok) return asToolResult(readiness.error);
  const startedAtMs = Date.now();
  // The supplied workspace is an expectation, never an authorization grant.
  // Registry rechecks current permissions and requires Runner 0.1.1+ for the
  // history-independent path; that Runner checks the actual Job before acting.
  const boundParams = { ...params, expected_workspace_id: workspaceId };
  const call = await callRunner(env, selected.value.runnerId, method, boundParams, readiness.value.applied_revision, readiness.value.active_checksum, workspaceBound);
  if (!call.ok) {
    const failure = runnerFailure(call.error, selected.value);
    const audit = await recordRunnerToolCall(env, {
      runnerId: selected.value.runnerId,
      clientId,
      method,
      params: boundParams,
      result: failure,
      startedAtMs,
      workspaceId,
      jobId: requestedJobId,
      readiness: readiness.value,
    }).catch(() => ({ correlation_id: `call-${crypto.randomUUID()}`, audit_status: "unknown" as const }));
    return withAuditReceipt(failure, audit);
  }
  // A live Runner is expected to echo the addressed job identity in metadata
  // and cancellation responses.  If it does, bind both IDs to the Registry
  // snapshot that passed the permission check; never return a cross-workspace
  // record from a stale/reused job ID.  Log/input acknowledgements may omit
  // workspace_id by contract, so they are still bound by the exact job_id
  // request and the Registry preflight above.
  if (!runnerJobResultMatches(call.value, requestedJobId, workspaceId)) {
    const failure = runnerFailure(failWithDetails("tool_result_invalid", "The Runner reply does not match the requested Job identity.", hintFor("tool_result_invalid", "unknown"), { job_id: requestedJobId, workspace_id: workspaceId }, "unknown").error, selected.value);
    const audit = await recordRunnerToolCall(env, {
      runnerId: selected.value.runnerId,
      clientId,
      method,
      params: boundParams,
      result: failure,
      startedAtMs,
      workspaceId,
      jobId: requestedJobId,
      readiness: readiness.value,
    }).catch(() => ({ correlation_id: `call-${crypto.randomUUID()}`, audit_status: "unknown" as const }));
    return withAuditReceipt(failure, audit);
  }
  const result = runnerSuccess(projectRunnerResult(call.value, resultMode), selected.value);
  const audit = await recordRunnerToolCall(env, {
    runnerId: selected.value.runnerId,
    clientId,
    method,
    params: boundParams,
    result,
    startedAtMs,
    workspaceId,
    jobId: requestedJobId,
    readiness: readiness.value,
  }).catch(() => ({ correlation_id: `call-${crypto.randomUUID()}`, audit_status: "unknown" as const }));
  return withAuditReceipt(result, audit);
}

async function activeJobList(env: McpRequestEnv, clientId: string, filters: Record<string, unknown>): Promise<unknown> {
  filters = { ...filters, limit: typeof filters.limit === "number" ? filters.limit : 10 };
  const selected = await resolveActiveRunner(env, clientId, true);
  if (!selected.ok) return asToolResult(selected);
  if (filters.workspace_id !== undefined) {
    const permission = await checkPermission(env, clientId, selected.value.runnerId, filters.workspace_id, "read");
    if (permission !== undefined) return asToolResult(permission);
  } else {
    const permission = await checkAnyReadPermission(env, clientId, selected.value.runnerId);
    if (permission !== undefined) return asToolResult(permission);
  }
  if (typeof filters.workspace_id === "string" && selected.value.context.state === "online") {
    const readiness = await policyReadiness(env, selected.value.runnerId);
    if (!readiness.ok) return asToolResult(readiness.error);
    const live = await callRunner(env, selected.value.runnerId, "job.list", filters, readiness.value.applied_revision, readiness.value.active_checksum);
    if (!live.ok) return runnerFailure(live.error, selected.value);
    const jobs = Array.isArray(live.value) ? live.value : isRecord(live.value) && Array.isArray(live.value.jobs) ? live.value.jobs : undefined;
    if (jobs === undefined || jobs.some((job) => !isRecord(job) || job.workspace_id !== filters.workspace_id)) return runnerFailure(fail("permission_denied", "The Runner returned jobs from an unexpected workspace.", "Use an authorized workspace and a current Runner.").error, selected.value);
    return runnerSuccess({ jobs: jobs.slice(0, typeof filters.limit === "number" ? filters.limit : 10).map(safeJobMetadata), source: "runner_live" }, selected.value);
  }
  const call = await registryCall(env, registryJobsPath(selected.value.runnerId, filters));
  if (!call.ok) return runnerFailure(call.error, selected.value);
  const value = isRecord(call.value) ? call.value : {};
  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  const visible: unknown[] = [];
  for (const job of jobs) {
    const workspaceId = isRecord(job) ? job.workspace_id : undefined;
    if (await checkPermission(env, clientId, selected.value.runnerId, workspaceId, "read") === undefined) {
      // Registry snapshots contain Runner-internal JobRecord fields (cwd,
      // command, PID, and process identity).  Keep the MCP contract to the
      // documented metadata allow-list even when a future Registry adds more
      // fields or redaction rules change.
      visible.push(safeJobMetadata(job));
    }
  }
  // Keep the outer envelope closed as well as each JobRecord.  Spreading a
  // Registry response here would let a future/internal field (for example a
  // root path or query diagnostic) cross the MCP boundary without going
  // through an explicit projection.
  const projected: Record<string, unknown> = { jobs: visible };
  const runnerId = safeJobIdentifier(value.runner_id);
  if (runnerId !== undefined) projected.runner_id = runnerId;
  if (selected.value.context.state !== "online") {
    projected.source = "registry_snapshot";
    projected.runner_state = "offline";
  }
  return runnerSuccess(projected, selected.value);
}

async function activeJobGet(env: McpRequestEnv, clientId: string, jobId: string, expectedWorkspaceId?: string): Promise<unknown> {
  if (expectedWorkspaceId !== undefined) return activeJobRunnerTool(env, clientId, "job.get", { job_id: jobId, workspace_id: expectedWorkspaceId }, "read", "job");
  const selected = await resolveActiveRunner(env, clientId, true);
  if (!selected.ok) return asToolResult(selected);
  const snapshot = await jobSnapshot(env, selected.value.runnerId, jobId);
  if (!snapshot.ok) return runnerFailure(snapshot.error, selected.value);
  const workspaceId = isRecord(snapshot.value) && typeof snapshot.value.workspace_id === "string" ? snapshot.value.workspace_id : undefined;
  if (workspaceId === undefined || !isSafeIdentifier(workspaceId)) {
    return runnerFailure(fail("permission_denied", "The operation is not permitted for this job.", "Use a job identifier belonging to an authorized workspace.").error, selected.value);
  }
  const permission = await checkPermission(env, clientId, selected.value.runnerId, workspaceId, "read");
  if (permission !== undefined) return asToolResult(permission);
  if (selected.value.context.state !== "online") {
    return runnerSuccess({ ...safeJobMetadata(snapshot.value), source: "registry_snapshot", runner_state: "offline" }, selected.value);
  }
  const readiness = await policyReadiness(env, selected.value.runnerId);
  if (!readiness.ok) return asToolResult(readiness.error);
  const live = await callRunner(env, selected.value.runnerId, "job.get", { job_id: jobId, expected_workspace_id: workspaceId }, readiness.value.applied_revision, readiness.value.active_checksum);
  if (live.ok) {
    if (!runnerJobResultMatches(live.value, jobId, workspaceId)) {
      return runnerFailure(failWithDetails("tool_result_invalid", "The Runner reply does not match the requested Job identity.", hintFor("tool_result_invalid", "unknown"), { job_id: jobId, workspace_id: workspaceId }, "unknown").error, selected.value);
    }
    return runnerSuccess(safeJobMetadata(live.value), selected.value);
  }
  if (live.error.code !== "runner_offline") return runnerFailure(live.error, selected.value);
  return runnerSuccess({ ...safeJobMetadata(snapshot.value), source: "registry_snapshot", runner_state: "offline" }, selected.value);
}

/** Missing optional cloud history is not proof that a local Job is absent.
 * Never discover a different workspace or replay a command automatically. */
async function jobSnapshot(env: McpRequestEnv, runnerId: string, jobId: string): Promise<ToolCall> {
  const result = await registryCall(env, `/runners/${encodeURIComponent(runnerId)}/jobs/${encodeURIComponent(jobId)}`);
  return !result.ok && result.error.code === "not_found"
    ? failWithDetails("job_history_unavailable", "The cloud Job record is unavailable; the original Job may still exist on this Runner.", hintFor("job_history_unavailable"), { job_id: jobId }, "not_started")
    : result;
}
