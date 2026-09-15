export type RpcFailureClass = "validation" | "authorization" | "availability" | "conflict" | "resource" | "execution" | "internal" | "unknown";
export type RpcOperationState = "not_started" | "running" | "committed" | "unknown";
export type RpcNextAction = "correct_request" | "refresh_permissions" | "wait_and_retry" | "re_read_and_retry" | "inspect_job" | "contact_operator";

export interface RpcFailureMetadata {
  readonly failure_class: RpcFailureClass;
  readonly operation_state: RpcOperationState;
  readonly retry_after_ms?: number;
  readonly next_action: RpcNextAction;
}

/** Single cross-layer source. A recoverable dependency does not make an
 * already-dispatched command safe to replay. Call sites may narrow state only
 * when their own control flow proves that no side effect was started. */
export function failureMetadata(code: string, observedState?: RpcOperationState): RpcFailureMetadata {
  let result: RpcFailureMetadata;
  if (["invalid_params", "invalid_request", "method_not_found", "invalid_path", "path_traversal", "invalid_patch", "not_utf8", "mixed_newlines"].includes(code)) result = { failure_class: "validation", operation_state: "not_started", next_action: "correct_request" };
  else if (["permission_denied", "insufficient_scope", "readonly_workspace", "stale_policy", "policy_pending"].includes(code)) result = { failure_class: "authorization", operation_state: "not_started", next_action: "refresh_permissions" };
  else if (["runner_offline", "service_unavailable", "registry_unavailable", "control_plane_unavailable", "timeout"].includes(code)) result = { failure_class: "availability", operation_state: "unknown", next_action: "inspect_job" };
  else if (code === "shell_unavailable") result = { failure_class: "availability", operation_state: "not_started", next_action: "correct_request" };
  else if (["baseline_changed", "expected_hash_mismatch", "hunk_ambiguous", "hunk_not_found", "hunk_overlap", "target_exists", "missing_file", "search_snapshot_changed", "request_id_conflict", "context_revision_conflict", "context_turn_conflict"].includes(code)) result = { failure_class: "conflict", operation_state: "not_started", next_action: "re_read_and_retry" };
  else if (["file_too_large", "git_output_too_large", "context_record_too_large", "context_index_too_large", "context_rebuild_budget", "queue_full", "busy"].includes(code)) result = code === "busy" || code === "queue_full" ? { failure_class: "resource", operation_state: "not_started", retry_after_ms: 1_000, next_action: "wait_and_retry" } : { failure_class: "resource", operation_state: "not_started", next_action: "correct_request" };
  else if (["patch_install_failed", "patch_rollback_failed", "symlink_write", "symlink_escape", "git_failed", "git_timeout"].includes(code)) result = { failure_class: "execution", operation_state: code === "patch_rollback_failed" ? "unknown" : "not_started", next_action: "inspect_job" };
  else if (code === "context_index_stale") result = { failure_class: "conflict", operation_state: "unknown", next_action: "inspect_job" };
  else if (["context_index_missing", "context_index_corrupt", "context_record_corrupt", "context_storage_unsafe"].includes(code)) result = { failure_class: "conflict", operation_state: "not_started", next_action: "contact_operator" };
  else result = { failure_class: "unknown", operation_state: "unknown", next_action: "contact_operator" };
  if (observedState !== undefined && observedState !== result.operation_state) {
    result = { ...result, operation_state: observedState };
    if (observedState === "not_started" && result.failure_class === "availability") result = { ...result, next_action: "wait_and_retry" };
    if (observedState !== "not_started") {
      const { retry_after_ms: _retry, ...rest } = result;
      result = { ...rest, next_action: "inspect_job" };
    }
  }
  return result;
}
