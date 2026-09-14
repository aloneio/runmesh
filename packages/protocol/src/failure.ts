export type RpcFailureClass = "validation" | "authorization" | "availability" | "conflict" | "resource" | "execution" | "internal" | "unknown";
export type RpcOperationState = "not_started" | "running" | "committed" | "unknown";
export type RpcNextAction = "correct_request" | "refresh_permissions" | "wait_and_retry" | "re_read_and_retry" | "inspect_job" | "contact_operator";

export interface RpcFailureMetadata {
  readonly failure_class: RpcFailureClass;
  readonly operation_state: RpcOperationState;
  readonly retry_after_ms?: number;
  readonly next_action: RpcNextAction;
}

export function failureMetadata(code: string): RpcFailureMetadata {
  if (["invalid_params", "invalid_request", "method_not_found", "invalid_path", "path_traversal", "invalid_patch", "not_utf8", "mixed_newlines"].includes(code)) return { failure_class: "validation", operation_state: "not_started", next_action: "correct_request" };
  if (["permission_denied", "insufficient_scope", "readonly_workspace", "stale_policy", "policy_pending"].includes(code)) return { failure_class: "authorization", operation_state: "not_started", next_action: "refresh_permissions" };
  if (["runner_offline", "service_unavailable", "registry_unavailable", "timeout", "shell_unavailable"].includes(code)) return { failure_class: "availability", operation_state: "unknown", next_action: "wait_and_retry" };
  if (["baseline_changed", "expected_hash_mismatch", "hunk_ambiguous", "hunk_not_found", "hunk_overlap", "target_exists", "missing_file"].includes(code)) return { failure_class: "conflict", operation_state: "not_started", next_action: "re_read_and_retry" };
  if (["file_too_large", "git_output_too_large", "busy"].includes(code)) return code === "busy" ? { failure_class: "resource", operation_state: "not_started", retry_after_ms: 1_000, next_action: "wait_and_retry" } : { failure_class: "resource", operation_state: "not_started", next_action: "correct_request" };
  if (["patch_install_failed", "patch_rollback_failed", "symlink_write", "symlink_escape", "git_failed", "git_timeout"].includes(code)) return { failure_class: "execution", operation_state: code === "patch_rollback_failed" ? "unknown" : "not_started", next_action: "inspect_job" };
  return { failure_class: "unknown", operation_state: "unknown", next_action: "contact_operator" };
}
