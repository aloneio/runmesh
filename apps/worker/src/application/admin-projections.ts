import type { ClientViewModel, RunnerSummaryViewModel } from "../contracts/admin-views.js";
import { parseNativeScopes } from "../contracts/identity.js";
import { record } from "../values.js";

function nullableTime(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function runnerPublicInfo(input: unknown): RunnerSummaryViewModel["public_info"] {
  if (input === null) return null;
  const value = record(input);
  if (value === undefined || typeof value.platform !== "string" || typeof value.architecture !== "string") {
    throw new TypeError("Invalid Runner public info");
  }
  return { platform: value.platform, architecture: value.architecture };
}

/** Decode Registry JSON once, selecting only the fields owned by the view. */
export function runnerSummary(input: unknown): RunnerSummaryViewModel {
  const value = record(input);
  if (value === undefined || typeof value.runner_id !== "string" || typeof value.display_name !== "string"
    || typeof value.state !== "string" || !nullableTime(value.last_heartbeat_ms)
    || (value.configured_execution_mode !== null && value.configured_execution_mode !== "dedicated_user" && value.configured_execution_mode !== "privileged_host")
    || (value.active_job_count !== undefined && (typeof value.active_job_count !== "number" || !Number.isSafeInteger(value.active_job_count) || value.active_job_count < 0))) {
    throw new TypeError("Invalid Runner display data");
  }
  return {
    runner_id: value.runner_id, display_name: value.display_name, state: value.state,
    last_heartbeat_ms: value.last_heartbeat_ms, configured_execution_mode: value.configured_execution_mode,
    public_info: runnerPublicInfo(value.public_info),
    ...(value.active_job_count === undefined ? {} : { active_job_count: value.active_job_count }),
  };
}
export function clientSummary(input: unknown): ClientViewModel {
  const value = record(input);
  const scopes = parseNativeScopes(value?.scopes, true);
  if (value === undefined || typeof value.client_id !== "string" || typeof value.label !== "string" || scopes === undefined
    || !nullableTime(value.revoked_at_ms) || !nullableTime(value.last_used_at_ms)
    || (value.active_runner_id !== null && typeof value.active_runner_id !== "string")
    || (value.record_jobs !== undefined && typeof value.record_jobs !== "boolean")) {
    throw new TypeError("Invalid client display data");
  }
  return {
    client_id: value.client_id, label: value.label, scopes,
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
