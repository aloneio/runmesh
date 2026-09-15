import type { ClientViewModel, RunnerSummaryViewModel } from "../contracts/admin-views.js";

/** All fields are selected, never spread from an internal database record. */
export function runnerSummary(value: RunnerSummaryViewModel): RunnerSummaryViewModel {
  return {
    runner_id: value.runner_id, display_name: value.display_name, state: value.state,
    last_heartbeat_ms: value.last_heartbeat_ms, configured_execution_mode: value.configured_execution_mode,
    public_info: value.public_info === null ? null : { platform: value.public_info.platform, architecture: value.public_info.architecture },
    ...(value.active_job_count === undefined ? {} : { active_job_count: value.active_job_count }),
  };
}
export function clientSummary(value: ClientViewModel): ClientViewModel {
  return {
    client_id: value.client_id, label: value.label, scopes: [...value.scopes],
    revoked_at_ms: value.revoked_at_ms, last_used_at_ms: value.last_used_at_ms,
    active_runner_id: value.active_runner_id,
    ...(value.record_jobs === undefined ? {} : { record_jobs: value.record_jobs }),
  };
}
/** Detailed administration is authorized before projection. Host roots belong
 * to the separate authorized workspace view, never to these Runner summaries. */
export function runnerDetail(value: Record<string, unknown>): Record<string, unknown> {
  const keys = ["runner_id", "display_name", "state", "valid_from_ms", "valid_until_ms", "validity_status", "configured_execution_mode", "metadata", "public_info", "last_heartbeat_ms", "desired_policy_revision", "desired_policy_checksum", "applied_policy_revision", "active_policy_checksum", "runner_reported_policy_revision", "runner_reported_policy_checksum", "policy_status", "runner_permissions", "current_runner_version", "protocol_min_version", "protocol_max_version", "protocol_compatibility", "update_channel", "desired_runner_version", "latest_runner_version", "update_status", "updated_at_ms", "connection_epoch", "credential_version"] as const;
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}
export function clientDetail(value: Record<string, unknown>): Record<string, unknown> {
  const keys = ["client_id", "label", "scopes", "revoked_at_ms", "last_used_at_ms", "active_runner_id", "active_runner_updated_at_ms", "record_jobs", "record_jobs_since_ms", "secret_prefix", "secret_version", "created_at_ms", "updated_at_ms"] as const;
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}
