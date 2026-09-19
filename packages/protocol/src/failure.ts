export type RpcFailureClass = "validation" | "authorization" | "availability" | "conflict" | "resource" | "execution" | "internal" | "unknown";
export type RpcOperationState = "not_started" | "running" | "committed" | "unknown";
export type RpcNextAction = "correct_request" | "refresh_permissions" | "wait_and_retry" | "re_read_and_retry" | "inspect_job" | "contact_operator";

export interface RpcFailureMetadata {
  readonly failure_class: RpcFailureClass;
  readonly operation_state: RpcOperationState;
  readonly retry_after_ms?: number;
  readonly next_action: RpcNextAction;
}

/** One catalog owns both classification and the public transport allow-list.
 * A new stable error must not silently become an unrelated bridge failure. */
const policies: ReadonlyArray<readonly [readonly string[], RpcFailureMetadata]> = [
  [["invalid_params", "invalid_request", "method_not_found", "invalid_path", "path_traversal", "invalid_patch", "not_utf8", "mixed_newlines", "invalid_runner_id", "invalid_workspace", "runner_not_selected", "runner_switch_confirmation_required", "request_too_large"], { failure_class: "validation", operation_state: "not_started", next_action: "correct_request" }],
  [["permission_denied", "insufficient_scope", "readonly_workspace", "stale_policy", "policy_pending", "runner_not_active", "runner_expired", "runner_not_authorized"], { failure_class: "authorization", operation_state: "not_started", next_action: "refresh_permissions" }],
  [["runner_offline", "service_unavailable", "registry_unavailable", "control_plane_unavailable", "timeout"], { failure_class: "availability", operation_state: "unknown", next_action: "inspect_job" }],
  [["runner_access_unavailable"], { failure_class: "availability", operation_state: "not_started", next_action: "wait_and_retry" }],
  [["git_unavailable", "runner_upgrade_required", "runner_unavailable", "no_runners_available"], { failure_class: "availability", operation_state: "not_started", next_action: "contact_operator" }],
  [["shell_unavailable", "job_history_unavailable"], { failure_class: "availability", operation_state: "not_started", next_action: "correct_request" }],
  [["log_unavailable"], { failure_class: "availability", operation_state: "not_started", next_action: "inspect_job" }],
  [["file_changed", "log_changed", "path_changed", "cursor_mismatch", "cursor_expired", "baseline_changed", "expected_hash_mismatch", "hunk_ambiguous", "hunk_not_found", "hunk_overlap", "target_exists", "missing_file", "search_snapshot_changed", "request_id_conflict", "context_revision_conflict", "context_turn_conflict", "context_plan_changed"], { failure_class: "conflict", operation_state: "not_started", next_action: "re_read_and_retry" }],
  [["not_found", "context_record_missing", "read_budget_exhausted", "snapshot_too_large", "file_too_large", "git_output_too_large", "context_record_too_large", "context_index_too_large", "context_rebuild_budget", "context_storage_full", "context_scan_budget"], { failure_class: "resource", operation_state: "not_started", next_action: "correct_request" }],
  [["queue_full", "busy"], { failure_class: "resource", operation_state: "not_started", retry_after_ms: 1_000, next_action: "wait_and_retry" }],
  [["patch_install_failed", "symlink_write", "symlink_escape", "git_failed", "git_timeout"], { failure_class: "execution", operation_state: "not_started", next_action: "inspect_job" }],
  [["patch_rollback_failed"], { failure_class: "execution", operation_state: "unknown", next_action: "inspect_job" }],
  [["context_index_stale"], { failure_class: "conflict", operation_state: "unknown", next_action: "inspect_job" }],
  [["context_prune_partial"], { failure_class: "conflict", operation_state: "unknown", next_action: "contact_operator" }],
  [["context_index_missing", "context_index_corrupt", "context_record_corrupt", "context_storage_unsafe"], { failure_class: "conflict", operation_state: "not_started", next_action: "contact_operator" }],
  [["authorization_response_invalid"], { failure_class: "internal", operation_state: "not_started", next_action: "contact_operator" }],
  [["internal_error", "runner_rpc_failed", "context_result_invalid", "tool_result_invalid"], { failure_class: "internal", operation_state: "unknown", next_action: "contact_operator" }],
];
const catalog: Readonly<Record<string, RpcFailureMetadata>> = Object.freeze(Object.fromEntries(
  policies.flatMap(([codes, metadata]) => codes.map(code => [code, Object.freeze(metadata)])),
));
export const RPC_FAILURE_CODES: readonly string[] = Object.freeze(Object.keys(catalog).sort());
export function isKnownRpcFailureCode(value: unknown): value is string { return typeof value === "string" && Object.hasOwn(catalog, value); }

/** A recoverable dependency does not make a dispatched command safe to replay.
 * Call sites may narrow state only when their control flow proves no effect. */
export function failureMetadata(code: string, observedState?: RpcOperationState): RpcFailureMetadata {
  let result: RpcFailureMetadata = isKnownRpcFailureCode(code) ? catalog[code]! : { failure_class: "unknown", operation_state: "unknown", next_action: "contact_operator" };
  // Isolation failures still need operator configuration on older Runners.
  if (code === "git_unavailable") return { ...result, operation_state: observedState ?? "not_started" };
  // A partial prune can never be downgraded to a pre-execution rejection.
  if (code === "context_prune_partial") return result;
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
