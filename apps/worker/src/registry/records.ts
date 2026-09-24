import type { CodingScope } from "../contracts/administration.js";
import { NATIVE_SCOPES } from "../contracts/identity.js";
import type { RegistryFeatureKey } from "../contracts/feature-health.js";
import type { RunnerConnectionState } from "../contracts/runner-selection.js";
import type { RunnerExecutionMode } from "../contracts/administration.js";
import type { RunnerMetadata } from "@aloneio/runmesh-protocol";
import type { RunnerPublicInfo } from "../contracts/runner-metadata.js";
import type { ValidityStatus } from "../validity.js";
import type { ValidityWindow } from "../validity.js";

export type { RunnerExecutionMode, CodingScope } from "../contracts/administration.js";

export type PolicyAcknowledgementResult = "applied" | "invalid" | "stale";

export interface RunnerMutationState {
  readonly runner_exists: boolean;
  /** Opaque identity for the current runner_id lifecycle. Internal callers
   * use this to prevent a delayed mutation from a deleted/recreated Runner
   * being attached to the new row. It is never exposed in public Runner
   * metadata. */
  readonly lifecycle_id: string | null;
  readonly runner_state: RunnerConnectionState | null;
  /** True only when the requested mutation is backed by a committed
   * credential-ledger marker for the current lifecycle/generation. The
   * broader mutation_committed field also includes policy mutations, so
   * transport credential finalizers must use this narrower proof. */
  readonly credential_mutation_committed: boolean;
  readonly mutation_committed: boolean;
  readonly desired_revision: number | null;
  readonly desired_checksum: string | null;
  readonly applied_revision: number | null;
  readonly active_checksum: string | null;
  readonly runner_reported_revision: number | null;
  readonly runner_reported_checksum: string | null;
  readonly policy_status: RunnerRecord["policy_status"] | null;
  readonly connection_epoch: number | null;
  readonly credential_version: number | null;
  readonly session_id: string | null;
}

export const VALID_SCOPES = new Set<CodingScope>(NATIVE_SCOPES);

export type PermissionBit = "read" | "edit" | "shell" | "job_control";

export type PermissionSet = Record<PermissionBit, boolean>;

export type RunnerProfilePreset = "locked" | "read_only" | "edit_only" | "controlled_exec" | "coding" | "full_control";

export type WorkspaceValidationStatus = "valid" | "missing" | "not_directory" | "permission_denied" | "invalid_path";

export type RunnerUpdateChannel = "stable" | "pinned";

export type RunnerProtocolCompatibility = "unknown" | "compatible" | "incompatible";

export type RunnerUpdateStatus = "unknown" | "up_to_date" | "update_available" | "pinned" | "incompatible";

export const LOCKED_PERMISSIONS: PermissionSet = { read: false, edit: false, shell: false, job_control: false };

export const READ_ONLY_PERMISSIONS: PermissionSet = { read: true, edit: false, shell: false, job_control: false };

export interface RunnerRecord extends ValidityWindow {
  readonly validity_status: ValidityStatus;
  readonly runner_id: string;
  readonly display_name: string;
  readonly state: RunnerConnectionState;
  readonly connection_epoch: number;
  readonly credential_version: number;
  /** Trusted administrator selection. Null means the Runner has not yet been
   * configured for enrollment. */
  readonly configured_execution_mode: RunnerExecutionMode | null;
  readonly session_id: string | null;
  readonly metadata: RunnerMetadata | null;
  /** Safe enrollment-time identity/version data, intentionally excluding paths and credentials. */
  readonly public_info: RunnerPublicInfo | null;
  readonly last_heartbeat_ms: number | null;
  readonly last_sync_sequence: number | null;
  readonly desired_policy_revision: number;
  readonly desired_policy_checksum: string | null;
  readonly applied_policy_revision: number | null;
  readonly active_policy_checksum: string | null;
  readonly runner_reported_policy_revision: number | null;
  readonly runner_reported_policy_checksum: string | null;
  readonly policy_status: "pending" | "offline_pending" | "applied" | "invalid";
  readonly runner_permissions: PermissionSet;
  /** Last actual Runner package/version observed at enrollment or handshake. */
  readonly current_runner_version: string | null;
  readonly protocol_min_version: number | null;
  readonly protocol_max_version: number | null;
  readonly protocol_compatibility: RunnerProtocolCompatibility;
  readonly update_channel: RunnerUpdateChannel;
  /** The exact requested version when the operator pins this Runner. */
  readonly desired_runner_version: string | null;
  /** Last stable descriptor version observed by an admin policy save. */
  readonly latest_runner_version: string | null;
  readonly update_status: RunnerUpdateStatus;
  readonly updated_at_ms: number;
}

export interface WorkspaceRecord {
  readonly runner_id: string;
  readonly workspace_id: string;
  readonly display_name: string;
  /** Admin/control-plane only; never use this type in MCP output. */
  readonly root_path: string;
  readonly enabled: boolean;
  readonly permissions: PermissionSet;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly revision: number;
  readonly validation_status: WorkspaceValidationStatus | null;
}

export interface DashboardRunnerRecord extends RunnerRecord {
  readonly workspace_count: number;
  readonly active_job_count: number;
}

export interface DashboardJobRecord {
  readonly runner_id: string;
  readonly job_id: string;
  readonly workspace_id: string;
  readonly status: string;
  readonly created_by_client_id: string | null;
  readonly updated_at_ms: number;
}

export interface DashboardMcpCallRecord {
  readonly runner_id: string;
  readonly call_id: string;
  readonly client_id: string;
  readonly method: string;
  readonly workspace_id: string | null;
  readonly job_id: string | null;
  readonly result_runner_id: string | null;
  readonly status: "ok" | "error";
  readonly error_code: string | null;
  readonly params: unknown;
  readonly result: unknown;
  readonly started_at_ms: number;
  readonly completed_at_ms: number;
  readonly duration_ms: number;
  readonly epoch: number;
  readonly credential_version: number;
  readonly lifecycle_id: string;
  readonly session_id: string;
  readonly recorded_at_ms: number;
}

export interface DashboardSnapshot {
  readonly runners: readonly DashboardRunnerRecord[];
  readonly jobs: readonly DashboardJobRecord[];
}

export interface McpClientRecord {
  /** Cloud history preference only; never changes execution permissions. */
  readonly record_jobs?: boolean;
  readonly record_jobs_since_ms?: number;
  readonly client_id: string;
  readonly label: string;
  readonly secret_prefix: string;
  readonly scopes: readonly CodingScope[];
  readonly secret_version: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly last_used_at_ms: number | null;
  readonly revoked_at_ms: number | null;
  /** Per-client MCP routing state. It survives client rename and key rotation. */
  readonly active_runner_id: string | null;
  readonly active_runner_updated_at_ms: number | null;
}

export type RunnerRow = ValidityWindow & {
  [key: string]: string | number | null;
  runner_id: string;
  display_name: string;
  token_verifier: string;
  state: RunnerConnectionState;
  connection_epoch: number;
  credential_version: number;
  /** Internal identity for one runner-id lifecycle; never exposed to callers. */
  lifecycle_id: string;
  configured_execution_mode: RunnerExecutionMode | null;
  session_id: string | null;
  metadata_json: string | null;
  public_info_json: string | null;
  last_heartbeat_ms: number | null;
  last_sync_sequence: number | null;
  desired_policy_revision: number;
  desired_policy_checksum: string | null;
  applied_policy_revision: number | null;
  active_policy_checksum: string | null;
  runner_reported_policy_revision: number | null;
  runner_reported_policy_checksum: string | null;
  policy_status: "pending" | "offline_pending" | "applied" | "invalid";
  runner_permissions_json: string;
  current_runner_version: string | null;
  protocol_min_version: number | null;
  protocol_max_version: number | null;
  protocol_compatibility: RunnerProtocolCompatibility;
  update_channel: RunnerUpdateChannel;
  desired_runner_version: string | null;
  latest_runner_version: string | null;
  update_status: RunnerUpdateStatus;
  updated_at_ms: number;
};

export type EnrollmentRow = { enrollment_id: string; runner_id: string; verifier: string; created_at_ms: number; not_before_ms: number; expires_at_ms: number; used_at_ms: number | null };

export type PolicyVersionRow = {
  runner_id: string; revision: number; checksum: string; policy_json: string; status: string;
  created_at_ms: number; acknowledged_at_ms: number | null; validation_summary_json: string | null;
  source_revision: number | null; mutation_id: string | null;
};

export type PolicyMutationKind = "workspace_create" | "workspace_update" | "workspace_delete" | "permissions" | "emergency_lock";

export type PolicyMutationRow = { runner_id: string; mutation_id: string; kind: PolicyMutationKind; fingerprint: string; revision: number; committed_at_ms: number };

export type CredentialMutationKind = "credential_rotate" | "credential_enroll" | "credential_revoke" | "runner_delete" | "runner_create";

export type CredentialMutationRow = { kind: CredentialMutationKind; pre_credential_version: number; lifecycle_id: string };

export type ManagedWorkspaceRow = {
  runner_id: string; workspace_id: string; display_name: string; root_path: string; enabled: number;
  permissions_json: string; created_at_ms: number; updated_at_ms: number; revision: number; validation_status: WorkspaceValidationStatus | null;
};

export type JobRow = { job_json: string };

export type McpCallRow = { call_json: string };

export type FeatureHealthRow = { feature: RegistryFeatureKey; disabled_until_ms: number | null; failure_count: number; last_failure_at_ms: number | null; last_error: string | null };

export type AdminSettingsRow = { password_verifier: string; session_version: number; created_at_ms: number; updated_at_ms: number };

export type AuthThrottleRow = { id: string; failed_attempts: number; blocked_until_ms: number; updated_at_ms: number };

export type AuthThrottleKind = "login" | "setup";

export type SessionRow = { csrf_hash: string; expires_at_ms: number; session_version: number };

export type McpClientRow = {
  record_jobs?: number; record_jobs_since_ms?: number;
  client_id: string; label: string; secret_verifier: string; secret_prefix: string; scopes_json: string;
  secret_version: number; created_at_ms: number; updated_at_ms: number; last_used_at_ms: number | null; revoked_at_ms: number | null;
  active_runner_id: string | null; active_runner_updated_at_ms: number | null;
};

export type InternalInput = Record<string, unknown>;

export const MAX_INTERNAL_BODY_BYTES = 1_048_576;

export const MAX_SYNC_ITEMS = 1_000;

export const MAX_TERMINAL_JOBS_PER_RUNNER = 1_000;

export const MAX_MCP_CALLS_PER_RUNNER = 1_000;

export const CLIENT_LAST_USED_WRITE_INTERVAL_MS = 60_000;

export const AUTH_THROTTLE_FAILURE_THRESHOLD = 5;

export const REGISTRY_HISTORY_CLEANUP_INTERVAL_MS = 15 * 60_000;

export const HISTORY_CLEANUP_DEADLINE_KEY = "maintenance.history-cleanup-deadline.v1";

export const AUTH_THROTTLE_INITIAL_BLOCK_MS = 30_000;

export const AUTH_THROTTLE_MAX_BLOCK_MS = 15 * 60_000;

export type ParsedTransportIdentity =
  | { readonly valid: true; readonly lifecycleId: string; readonly sessionId: string }
  | { readonly valid: false; readonly lifecycleId: undefined; readonly sessionId: undefined };

export type { VerifiedMcpClient } from "../contracts/mcp-principal.js";

export { DEFAULT_RUNNER_ENROLLMENT_TTL_MS } from "../contracts/enrollment-options.js";

export { RUNNER_ENROLLMENT_TTL_OPTIONS_MS } from "../contracts/enrollment-options.js";

export type { RunnerPublicInfo } from "../contracts/runner-metadata.js";
export type { RegistryFeatureKey } from "../contracts/feature-health.js";
export type { RegistryFeatureHealth } from "../contracts/feature-health.js";
