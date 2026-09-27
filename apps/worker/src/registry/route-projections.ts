import type { RunnerPolicy } from "@aloneio/runmesh-protocol";
import type { PolicyVersionRow, RunnerRecord } from "./records.js";

/** Representation only; callers retain ownership of authority and mutations. */
export function registryInputError(value: {
  readonly error: string;
  readonly status: number;
}): Response {
  return Response.json({
    error: value.error
  }, {
    status: value.status
  });
}
export function projectActiveWorkspaces(runnerId: string, policy: RunnerPolicy) {
  return {
    runner_id: runnerId,
    revision: policy.revision,
    checksum: policy.checksum,
    workspaces: policy.workspaces.map(workspace => ({
      workspace_id: workspace.workspace_id,
      enabled: workspace.enabled,
      permissions: workspace.permissions
    }))
  };
}
export function projectPolicyVersions(runnerId: string, versions: readonly PolicyVersionRow[]) {
  return {
    runner_id: runnerId,
    versions: versions.map(version => ({
      revision: version.revision,
      checksum: version.checksum.slice(0, 12),
      status: version.status,
      created_at_ms: version.created_at_ms,
      acknowledged_at_ms: version.acknowledged_at_ms,
      source_revision: version.source_revision,
      mutation_id: version.mutation_id,
      validation_summary: version.validation_summary_json === null ? null : JSON.parse(version.validation_summary_json)
    }))
  };
}
export function projectPolicyRevision(runner: Pick<RunnerRecord,
  "desired_policy_revision" | "desired_policy_checksum" | "applied_policy_revision" | "active_policy_checksum"
  | "runner_reported_policy_revision" | "runner_reported_policy_checksum" | "policy_status"
>, mutationId: string | null | undefined) {
  return {
    desired_policy_revision: runner.desired_policy_revision,
    desired_policy_checksum: runner.desired_policy_checksum,
    desired_policy_mutation_id: mutationId ?? null,
    applied_policy_revision: runner.applied_policy_revision,
    active_policy_checksum: runner.active_policy_checksum,
    runner_reported_policy_revision: runner.runner_reported_policy_revision,
    runner_reported_policy_checksum: runner.runner_reported_policy_checksum,
    policy_status: runner.policy_status
  };
}

/** Inputs are already metadata-only. External rows win when history overlaps. */
export function projectCombinedMcpCalls(runnerId: string, local: readonly Record<string, unknown>[], external: readonly Record<string, unknown>[], limit?: number) {
  const unique = [...new Map([...local, ...external].map(row => [String(row.call_id), row])).values()];
  unique.sort((a, b) => Number(b.completed_at_ms) - Number(a.completed_at_ms) || String(b.call_id).localeCompare(String(a.call_id)));
  return {
    runner_id: runnerId,
    history_backend: "d1",
    calls: unique.slice(0, limit ?? 100)
  };
}
