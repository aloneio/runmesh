import type { ActiveRunnerContext } from "../contracts/runner-selection.js";
import { parseNativeScopes, parseStoredNativeScopes } from "../contracts/identity.js";
import { JobCompletedSchema } from "@aloneio/runmesh-protocol";
import { JobStartedSchema } from "@aloneio/runmesh-protocol";
import { JobStatusMessageSchema } from "@aloneio/runmesh-protocol";
import { IdentifierSchema } from "@aloneio/runmesh-protocol";
import { PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { validatePermissionSet } from "@aloneio/runmesh-protocol";
import type { RunnerMetadata } from "@aloneio/runmesh-protocol";
import { isSafeIdentifier } from "../security.js";
import { validityStatus } from "../validity.js";
import type { RunnerExecutionMode, RunnerMutationState, CodingScope, PermissionSet, WorkspaceValidationStatus, RunnerUpdateChannel, RunnerProtocolCompatibility, RunnerUpdateStatus, RunnerPublicInfo, RunnerRecord, WorkspaceRecord, McpClientRecord, RunnerRow, PolicyMutationKind, ManagedWorkspaceRow, AuthThrottleKind, McpClientRow, InternalInput, ParsedTransportIdentity } from './records.js';
import { VALID_SCOPES, LOCKED_PERMISSIONS, DEFAULT_RUNNER_ENROLLMENT_TTL_MS, RUNNER_ENROLLMENT_TTL_OPTIONS_MS } from './records.js';

/** Existing value validation/projection. No Registry instance or storage dependency. */
export function authThrottleKind(value: unknown): AuthThrottleKind | undefined { return value === "login" || value === "setup" ? value : undefined; }

export function validRunnerVersion(value: string): boolean { return value.length > 0 && value.length <= 256 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value); }

export function validLifecycleId(value: string): boolean { return value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value); }

export function validSessionId(value: string): boolean { return isSafeIdentifier(value); }

export function validTransportIdentity(lifecycleId: string, sessionId: string): boolean {
  return validLifecycleId(lifecycleId) && validSessionId(sessionId);
}

export function parseTransportIdentity(input: InternalInput): ParsedTransportIdentity {
  const rawLifecycle = input.lifecycle_id;
  const rawSession = input.session_id;
  if (typeof rawLifecycle === "string" && validLifecycleId(rawLifecycle)
    && typeof rawSession === "string" && validSessionId(rawSession)) {
    return { valid: true, lifecycleId: rawLifecycle, sessionId: rawSession };
  }
  // Missing/null/non-string fields intentionally fail closed.
  return { valid: false, lifecycleId: undefined, sessionId: undefined };
}

export function matchesTransportIdentity(row: Pick<RunnerRow, "lifecycle_id" | "session_id"> | undefined, lifecycleId: string, sessionId: string): boolean {
  return row !== undefined && row.lifecycle_id === lifecycleId && row.session_id === sessionId;
}

export function validUpdateChannel(value: unknown): value is RunnerUpdateChannel { return value === "stable" || value === "pinned"; }

export function validUpdateStatus(value: unknown): value is RunnerUpdateStatus { return value === "unknown" || value === "up_to_date" || value === "update_available" || value === "pinned" || value === "incompatible"; }

export function validExecutionMode(value: unknown): value is RunnerExecutionMode { return value === "dedicated_user" || value === "privileged_host"; }

export function validOptionalExecutionMode(value: unknown): value is RunnerExecutionMode | undefined { return value === undefined || validExecutionMode(value); }

export function validExpectedExecutionMode(value: unknown): value is RunnerExecutionMode | null | undefined { return value === undefined || value === null || validExecutionMode(value); }

export function requestedExecutionMode(input: InternalInput): RunnerExecutionMode | undefined | null {
  const hasPrimary = Object.prototype.hasOwnProperty.call(input, "execution_mode");
  if (!hasPrimary) return undefined;
  return validExecutionMode(input.execution_mode) ? input.execution_mode : null;
}

export function requestedExpectedExecutionMode(input: InternalInput): RunnerExecutionMode | null | undefined | "invalid" {
  if (!Object.prototype.hasOwnProperty.call(input, "expected_execution_mode")) return undefined;
  const value = input.expected_execution_mode;
  return value === null ? null : validExecutionMode(value) ? value : "invalid";
}

export function requestedExpectedLifecycleId(input: InternalInput): string | undefined | null {
  if (!Object.prototype.hasOwnProperty.call(input, "expected_lifecycle_id")) return undefined;
  const value = input.expected_lifecycle_id;
  return typeof value === "string" && validLifecycleId(value) ? value : null;
}

export function requestedPrivilegedConfirmation(input: InternalInput): boolean | undefined | null {
  if (!Object.prototype.hasOwnProperty.call(input, "confirm_privileged_host")) return undefined;
  return typeof input.confirm_privileged_host === "boolean" ? input.confirm_privileged_host : null;
}

export function validRunnerEnrollmentTtl(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && (RUNNER_ENROLLMENT_TTL_OPTIONS_MS as readonly number[]).includes(value);
}

export function requestedRunnerEnrollmentTtl(input: InternalInput): number | null {
  if (!Object.prototype.hasOwnProperty.call(input, "enrollment_ttl_ms")) return DEFAULT_RUNNER_ENROLLMENT_TTL_MS;
  return validRunnerEnrollmentTtl(input.enrollment_ttl_ms) ? input.enrollment_ttl_ms : null;
}

export function protocolCompatibility(minVersion: number, maxVersion: number): RunnerProtocolCompatibility { return minVersion <= PROTOCOL_CURRENT_VERSION && maxVersion >= PROTOCOL_MIN_VERSION ? "compatible" : "incompatible"; }

export function updateStatus(channel: RunnerUpdateChannel, desired: string | undefined, latest: string | undefined, current: { current_runner_version?: string | null; protocol_compatibility?: RunnerProtocolCompatibility } | undefined): RunnerUpdateStatus {
  if (current?.protocol_compatibility === "incompatible") return "incompatible";
  if (channel === "pinned") return desired !== undefined && current?.current_runner_version === desired ? "pinned" : "update_available";
  if (latest === undefined || current?.current_runner_version === undefined || current.current_runner_version === null) return "unknown";
  return current.current_runner_version === latest ? "up_to_date" : "update_available";
}

export function emptyMutationState(): RunnerMutationState {
  return { runner_exists: false, lifecycle_id: null, runner_state: null, credential_mutation_committed: false, mutation_committed: false, desired_revision: null, desired_checksum: null, applied_revision: null, active_checksum: null, runner_reported_revision: null, runner_reported_checksum: null, policy_status: null, connection_epoch: null, credential_version: null, session_id: null };
}

export function decodeRunner(row: RunnerRow): RunnerRecord {
  return {
    valid_from_ms: row.valid_from_ms, valid_until_ms: row.valid_until_ms, validity_status: validityStatus(row),
    runner_id: row.runner_id, display_name: row.display_name || row.runner_id, state: row.state, connection_epoch: row.connection_epoch,
    configured_execution_mode: validExecutionMode(row.configured_execution_mode) ? row.configured_execution_mode : null,
    credential_version: row.credential_version, session_id: row.session_id, metadata: row.metadata_json === null ? null : JSON.parse(row.metadata_json) as RunnerMetadata,
    public_info: row.public_info_json === null ? null : JSON.parse(row.public_info_json) as RunnerPublicInfo, last_heartbeat_ms: row.last_heartbeat_ms,
    last_sync_sequence: row.last_sync_sequence, desired_policy_revision: row.desired_policy_revision ?? 0, desired_policy_checksum: row.desired_policy_checksum, applied_policy_revision: row.applied_policy_revision, active_policy_checksum: row.active_policy_checksum,
    runner_reported_policy_revision: row.runner_reported_policy_revision, runner_reported_policy_checksum: row.runner_reported_policy_checksum,
    policy_status: row.policy_status === "applied" || row.policy_status === "invalid" || row.policy_status === "offline_pending" ? row.policy_status : "pending",
    runner_permissions: parsePermissionSet(row.runner_permissions_json) ?? LOCKED_PERMISSIONS,
    current_runner_version: row.current_runner_version, protocol_min_version: row.protocol_min_version, protocol_max_version: row.protocol_max_version,
    protocol_compatibility: row.protocol_compatibility === "compatible" || row.protocol_compatibility === "incompatible" ? row.protocol_compatibility : "unknown",
    update_channel: row.update_channel === "pinned" ? "pinned" : "stable", desired_runner_version: row.desired_runner_version,
    latest_runner_version: row.latest_runner_version, update_status: validUpdateStatus(row.update_status) ? row.update_status : "unknown", updated_at_ms: row.updated_at_ms,
  };
}

export function decodeWorkspace(row: ManagedWorkspaceRow): WorkspaceRecord[] {
  const permissions = parsePermissionSet(row.permissions_json);
  return permissions === undefined ? [] : [{ runner_id: row.runner_id, workspace_id: row.workspace_id, display_name: row.display_name, root_path: row.root_path, enabled: row.enabled === 1, permissions, created_at_ms: row.created_at_ms, updated_at_ms: row.updated_at_ms, revision: row.revision, validation_status: row.validation_status }];
}

export function decodeMcpClient(row: McpClientRow): McpClientRecord { const scopes = parseStoredNativeScopes(row.scopes_json) ?? []; return { record_jobs: row.record_jobs !== 0, record_jobs_since_ms: row.record_jobs_since_ms ?? 0, client_id: row.client_id, label: row.label, secret_prefix: row.secret_prefix, scopes, secret_version: row.secret_version, created_at_ms: row.created_at_ms, updated_at_ms: row.updated_at_ms, last_used_at_ms: row.last_used_at_ms, revoked_at_ms: row.revoked_at_ms, active_runner_id: row.active_runner_id, active_runner_updated_at_ms: row.active_runner_updated_at_ms }; }

export function safeRunnerContext(runner: RunnerRecord, updatedAtMs: number | null): ActiveRunnerContext {
  return { runner_id: runner.runner_id, state: runner.state, available: runner.state === "online", updated_at_ms: updatedAtMs };
}

export function parseJobEvent(value: unknown): { job: { job_id: string; runner_id?: string | undefined } } | undefined { if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined; const input = value as { type?: unknown }; const parsed = input.type === "job.started" ? JobStartedSchema.safeParse(value) : input.type === "job.status" ? JobStatusMessageSchema.safeParse(value) : input.type === "job.completed" ? JobCompletedSchema.safeParse(value) : undefined; return parsed?.success ? { job: parsed.data.job } : undefined; }

export function uniqueIds(values: readonly string[]): boolean { return new Set(values).size === values.length; }

export function parseRunnerId(value: string | undefined): string | undefined { if (value === undefined) return undefined; try { const decoded = decodeURIComponent(value); return isSafeIdentifier(decoded) && IdentifierSchema.safeParse(decoded).success ? decoded : undefined; } catch { return undefined; } }

export function parseJsonObject(body: string): InternalInput | undefined { try { const value = JSON.parse(body) as unknown; return typeof value === "object" && value !== null && !Array.isArray(value) ? value as InternalInput : undefined; } catch { return undefined; } }

export function stringField(input: InternalInput, field: string, maxLength: number): string | undefined { const value = input[field]; return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined; }

export function integerField(input: InternalInput, field: string): number | undefined { const value = input[field]; return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }

export function nullableIntegerField(input: InternalInput, field: string): number | null | undefined { const value = input[field]; return value === null ? null : typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined; }

export function safeNonnegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

export function nullableChecksumField(input: InternalInput, field: string): string | null | undefined { const value = input[field]; return value === null ? null : typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined; }

export function runnerPublicInfoField(value: unknown): RunnerPublicInfo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!safePublicText(item.platform, 128) || !safePublicText(item.architecture, 128) || !safePublicText(item.hostname, 256) || !safePublicText(item.runner_version, 256) || typeof item.protocol_version !== "number") return undefined;
  const info: RunnerPublicInfo = {
    platform: item.platform,
    architecture: item.architecture,
    hostname: item.hostname,
    runner_version: item.runner_version,
    protocol_version: item.protocol_version,
    ...(item.execution_mode === "dedicated_user" || item.execution_mode === "privileged_host" ? { execution_mode: item.execution_mode } : {}),
    ...(typeof item.service_identity === "string" && safePublicText(item.service_identity, 512) ? { service_identity: item.service_identity } : {}),
    ...(item.privilege_state === "privileged" || item.privilege_state === "restricted" || item.privilege_state === "mismatch" || item.privilege_state === "unknown" ? { privilege_state: item.privilege_state } : {}),
  };
  return Number.isSafeInteger(info.protocol_version) && info.protocol_version > 0 && info.protocol_version <= 1_000 ? info : undefined;
}

export function safePublicText(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value); }

export function permissionSetField(value: unknown): PermissionSet | undefined {
  const permissions = validatePermissionSet(value);
  return permissions === undefined ? undefined : { ...permissions };
}

export function parsePermissionSet(value: string): PermissionSet | undefined { try { return permissionSetField(JSON.parse(value) as unknown); } catch { return undefined; } }

export function validPermissionSet(value: unknown): value is PermissionSet { return permissionSetField(value) !== undefined; }

export function absoluteWorkspaceRoot(value: string): boolean {
  // The Runner's path policy resolves user paths beneath a configured root;
  // accepting a relative root here would defer a known-invalid configuration
  // until the Runner starts. Support POSIX, drive-letter, and UNC forms so the
  // same validation works for policies authored on either platform.
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/u.test(value);
}

export function validWorkspaceInput(value: { workspace_id: string; display_name: string; root_path: string; enabled: boolean; permissions: PermissionSet }): boolean {
  return isSafeIdentifier(value.workspace_id) && validLabel(value.display_name) && value.root_path.length > 0 && value.root_path.length <= 4_096
    && absoluteWorkspaceRoot(value.root_path) && !/[\u0000-\u001f\u007f]/u.test(value.root_path) && validPermissionSet(value.permissions);
}

export function validPolicyJson(value: { runner_permissions?: unknown; workspaces?: unknown }): boolean {
  return permissionSetField(value.runner_permissions) !== undefined && Array.isArray(value.workspaces) && value.workspaces.length <= 64 && new Set(value.workspaces.map((workspace) => typeof workspace === "object" && workspace !== null && !Array.isArray(workspace) ? (workspace as Record<string, unknown>).workspace_id : undefined)).size === value.workspaces.length && value.workspaces.every((workspace) => {
    if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) return false;
    const item = workspace as Record<string, unknown>;
    return typeof item.workspace_id === "string" && isSafeIdentifier(item.workspace_id) && typeof item.root_path === "string" && item.root_path.length > 0 && item.root_path.length <= 4_096 && absoluteWorkspaceRoot(item.root_path) && !/[\u0000-\u001f\u007f]/u.test(item.root_path) && typeof item.enabled === "boolean" && permissionSetField(item.permissions) !== undefined;
  });
}

export function workspaceStatusesField(value: unknown): Array<{ workspace_id: string; status: WorkspaceValidationStatus; validation_stage?: "realpath" | "lstat"; reason?: "os_access_denied"; service_identity?: string; execution_mode?: "dedicated_user" | "privileged_host"; remediation_code?: "migrate_privileged_host" | "grant_os_access" | "confirm_privileged_host" | "check_workspace_acl" | "run_as_admin" }> | undefined {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const valid = new Set<WorkspaceValidationStatus>(["valid", "missing", "not_directory", "permission_denied", "invalid_path"]);
  const stages = new Set(["realpath", "lstat"]);
  const outputs: Array<{ workspace_id: string; status: WorkspaceValidationStatus; validation_stage?: "realpath" | "lstat"; reason?: "os_access_denied"; service_identity?: string; execution_mode?: "dedicated_user" | "privileged_host"; remediation_code?: "migrate_privileged_host" | "grant_os_access" | "confirm_privileged_host" | "check_workspace_acl" | "run_as_admin" }> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const itemValue = item as Record<string, unknown>;
    if (typeof itemValue.workspace_id !== "string" || !isSafeIdentifier(itemValue.workspace_id) || typeof itemValue.status !== "string" || !valid.has(itemValue.status as WorkspaceValidationStatus)) return undefined;
    const next: { workspace_id: string; status: WorkspaceValidationStatus; validation_stage?: "realpath" | "lstat"; reason?: "os_access_denied"; service_identity?: string; execution_mode?: "dedicated_user" | "privileged_host"; remediation_code?: "migrate_privileged_host" | "grant_os_access" | "confirm_privileged_host" | "check_workspace_acl" | "run_as_admin" } = { workspace_id: itemValue.workspace_id, status: itemValue.status as WorkspaceValidationStatus };
    if (typeof itemValue.validation_stage === "string" && stages.has(itemValue.validation_stage)) next.validation_stage = itemValue.validation_stage as "realpath" | "lstat";
    if (itemValue.reason === "os_access_denied") next.reason = itemValue.reason;
    if (typeof itemValue.service_identity === "string" && safePublicText(itemValue.service_identity, 256)) next.service_identity = itemValue.service_identity;
    if (itemValue.execution_mode === "dedicated_user" || itemValue.execution_mode === "privileged_host") next.execution_mode = itemValue.execution_mode;
    if (itemValue.remediation_code === "migrate_privileged_host" || itemValue.remediation_code === "grant_os_access" || itemValue.remediation_code === "confirm_privileged_host" || itemValue.remediation_code === "check_workspace_acl" || itemValue.remediation_code === "run_as_admin") next.remediation_code = itemValue.remediation_code;
    outputs.push(next);
  }
  return outputs;
}

export function validVerifier(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }

export function validMutationId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }

export function validOptionalMutationId(value: string | undefined): boolean { return value === undefined || validMutationId(value); }

export function mutationIdField(input: InternalInput): string | undefined { return validMutationId(input.mutation_id) ? input.mutation_id : undefined; }

export function policyMutationFingerprint(kind: PolicyMutationKind, value: Record<string, unknown>): string {
  // Inputs are already bounded/validated by the public mutators. Pick fields
  // explicitly so retries remain stable even if a caller serializes the same
  // object with a different key order.
  if (kind === "workspace_create" || kind === "workspace_update") {
    const permissions = value.permissions as PermissionSet;
    return JSON.stringify({ kind, workspace_id: value.workspace_id, display_name: value.display_name, root_path: value.root_path, enabled: value.enabled, permissions: { read: permissions.read, edit: permissions.edit, shell: permissions.shell, job_control: permissions.job_control } });
  }
  if (kind === "workspace_delete") return JSON.stringify({ kind, workspace_id: value.workspace_id });
  const permissions = value.permissions as PermissionSet;
  return JSON.stringify({ kind, permissions: { read: permissions.read, edit: permissions.edit, shell: permissions.shell, job_control: permissions.job_control } });
}

export function validLabel(value: string): boolean { return value.trim().length >= 1 && value.length <= 256; }

export function validRunnerPublicInfo(value: RunnerPublicInfo): boolean {
  return value.platform.length > 0 && value.platform.length <= 128
    && value.architecture.length > 0 && value.architecture.length <= 128
    && value.hostname.length > 0 && value.hostname.length <= 256
    && value.runner_version.length > 0 && value.runner_version.length <= 256
    && Number.isSafeInteger(value.protocol_version) && value.protocol_version > 0 && value.protocol_version <= 1_000
    && (value.execution_mode === undefined || value.execution_mode === "dedicated_user" || value.execution_mode === "privileged_host")
    && (value.service_identity === undefined || safePublicText(value.service_identity, 512))
    && (value.privilege_state === undefined || value.privilege_state === "privileged" || value.privilege_state === "restricted" || value.privilege_state === "mismatch" || value.privilege_state === "unknown");
}

export function validScopes(value: readonly CodingScope[]): boolean { return parseNativeScopes(value) !== undefined; }

export function scopesField(value: unknown): CodingScope[] | undefined { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !VALID_SCOPES.has(item as CodingScope))) return undefined; const scopes = value as CodingScope[]; return validScopes(scopes) ? scopes : undefined; }

export function parseScopes(value: string): CodingScope[] | undefined { try { return scopesField(JSON.parse(value) as unknown); } catch { return undefined; } }

export function expectedRegistryConflict(error: unknown, messages: readonly string[]): boolean {
  return error instanceof Error && (messages.includes(error.message) || /UNIQUE constraint failed:/i.test(error.message));
}
