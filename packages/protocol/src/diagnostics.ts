import { z } from "zod";
import {
  IdentifierSchema,
  type JsonValue,
  type RunnerMetadata,
  type RunnerPolicyAck,
} from "./schema.js";

/**
 * Extension names are deliberately namespaced and versioned.  The envelope
 * has always allowed arbitrary JSON under `extensions`, so an upgraded peer
 * can carry diagnostics without adding unknown keys to the strict message
 * objects used by older peers.
 */
export const RUNNER_DIAGNOSTICS_EXTENSION = "runmesh.runner_diagnostics.v1" as const;
export const RUNNER_POLICY_DIAGNOSTICS_EXTENSION = "runmesh.runner_policy_diagnostics.v1" as const;
export const RUNNER_DIAGNOSTICS_FEATURE_EXTENSION = "runmesh.runner_diagnostics_features.v1" as const;

export type RunnerDiagnostics = Pick<RunnerMetadata, "execution_mode" | "service_identity" | "privilege_state">;
export type WorkspaceDiagnostic = RunnerPolicyAck["workspace_status"][number];

const RunnerDiagnosticsSchema = z.object({
  execution_mode: z.enum(["dedicated_user", "privileged_host"]).optional(),
  service_identity: z.string().min(1).max(256).refine(noControlCharacters, "service_identity contains control characters").optional(),
  privilege_state: z.enum(["privileged", "restricted", "mismatch", "unknown"]).optional(),
}).strict();

const WorkspaceDiagnosticSchema = z.object({
  workspace_id: IdentifierSchema,
  status: z.enum(["valid", "missing", "not_directory", "permission_denied", "invalid_path"]),
  validation_stage: z.enum(["realpath", "lstat"]).optional(),
  reason: z.literal("os_access_denied").optional(),
  service_identity: z.string().min(1).max(256).refine(noControlCharacters, "service_identity contains control characters").optional(),
  execution_mode: z.enum(["dedicated_user", "privileged_host"]).optional(),
  remediation_code: z.enum(["migrate_privileged_host", "grant_os_access", "confirm_privileged_host", "check_workspace_acl", "run_as_admin"]).optional(),
}).strict();

const RunnerPolicyDiagnosticsSchema = z.array(WorkspaceDiagnosticSchema).max(64);
const RunnerDiagnosticsFeaturesSchema = z.object({ policy_ack_direct: z.literal(true) }).strict();

/** Return only the legacy Runner metadata shape for the initial hello frame. */
export function stripRunnerDiagnostics(metadata: RunnerMetadata): Omit<RunnerMetadata, keyof RunnerDiagnostics> {
  return {
    runner_id: metadata.runner_id,
    runner_version: metadata.runner_version,
    platform: metadata.platform,
    architecture: metadata.architecture,
    capabilities: metadata.capabilities,
  };
}

/** Encode local Runner identity details under the backwards-compatible envelope extension. */
export function runnerDiagnosticsExtension(metadata: RunnerMetadata): Record<string, JsonValue> | undefined {
  const diagnostics: Record<string, JsonValue> = {};
  if (metadata.execution_mode !== undefined) diagnostics.execution_mode = metadata.execution_mode;
  if (metadata.service_identity !== undefined) diagnostics.service_identity = metadata.service_identity;
  if (metadata.privilege_state !== undefined) diagnostics.privilege_state = metadata.privilege_state;
  return Object.keys(diagnostics).length === 0 ? undefined : diagnostics;
}

/** Parse only the known Runner diagnostic extension; malformed additions are ignored. */
export function parseRunnerDiagnosticsExtension(extensions: unknown): RunnerDiagnostics | undefined {
  const value = extensionValue(extensions, RUNNER_DIAGNOSTICS_EXTENSION);
  const parsed = RunnerDiagnosticsSchema.safeParse(value);
  return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
}

/** Merge extension diagnostics without allowing them to override explicit direct fields. */
export function mergeRunnerDiagnostics(metadata: RunnerMetadata, extensions: unknown): RunnerMetadata {
  const diagnostics = parseRunnerDiagnosticsExtension(extensions);
  if (diagnostics === undefined) return metadata;
  const merged: RunnerMetadata = { ...metadata };
  if (merged.execution_mode === undefined && diagnostics.execution_mode !== undefined) merged.execution_mode = diagnostics.execution_mode;
  if (merged.service_identity === undefined && diagnostics.service_identity !== undefined) merged.service_identity = diagnostics.service_identity;
  if (merged.privilege_state === undefined && diagnostics.privilege_state !== undefined) merged.privilege_state = diagnostics.privilege_state;
  return merged;
}

/** Return the full diagnostic workspace status for a new peer, if present. */
export function policyDiagnosticsExtension(status: readonly WorkspaceDiagnostic[]): JsonValue[] | undefined {
  const hasDiagnostics = status.some((item) => item.validation_stage !== undefined || item.reason !== undefined || item.service_identity !== undefined || item.execution_mode !== undefined || item.remediation_code !== undefined);
  if (!hasDiagnostics) return undefined;
  return status.map((item) => {
    const diagnostic: Record<string, JsonValue> = { workspace_id: item.workspace_id, status: item.status };
    if (item.validation_stage !== undefined) diagnostic.validation_stage = item.validation_stage;
    if (item.reason !== undefined) diagnostic.reason = item.reason;
    if (item.service_identity !== undefined) diagnostic.service_identity = item.service_identity;
    if (item.execution_mode !== undefined) diagnostic.execution_mode = item.execution_mode;
    if (item.remediation_code !== undefined) diagnostic.remediation_code = item.remediation_code;
    return diagnostic;
  });
}

/** Strip optional fields so an ACK remains valid for pre-diagnostics strict peers. */
export function stripWorkspaceDiagnostics(status: readonly WorkspaceDiagnostic[]): Array<Pick<WorkspaceDiagnostic, "workspace_id" | "status">> {
  return status.map((item) => ({ workspace_id: item.workspace_id, status: item.status }));
}

/**
 * Merge extension diagnostics into the base ACK statuses.  IDs and statuses
 * come from the already schema-validated base array; extension entries can
 * only fill missing diagnostic fields for a matching item.
 */
export function mergeWorkspaceDiagnostics(status: readonly WorkspaceDiagnostic[], extensions: unknown): WorkspaceDiagnostic[] {
  const value = extensionValue(extensions, RUNNER_POLICY_DIAGNOSTICS_EXTENSION);
  const parsed = RunnerPolicyDiagnosticsSchema.safeParse(value);
  if (!parsed.success) return [...status];
  const byId = new Map<string, WorkspaceDiagnostic>();
  for (const item of parsed.data) {
    if (byId.has(item.workspace_id)) return [...status];
    byId.set(item.workspace_id, item);
  }
  return status.map((item) => {
    const extra = byId.get(item.workspace_id);
    if (extra === undefined || extra.status !== item.status) return item;
    const merged: WorkspaceDiagnostic = { ...item };
    if (merged.validation_stage === undefined && extra.validation_stage !== undefined) merged.validation_stage = extra.validation_stage;
    if (merged.reason === undefined && extra.reason !== undefined) merged.reason = extra.reason;
    if (merged.service_identity === undefined && extra.service_identity !== undefined) merged.service_identity = extra.service_identity;
    if (merged.execution_mode === undefined && extra.execution_mode !== undefined) merged.execution_mode = extra.execution_mode;
    if (merged.remediation_code === undefined && extra.remediation_code !== undefined) merged.remediation_code = extra.remediation_code;
    return merged;
  });
}

/** A Worker advertises this only after it can consume direct ACK diagnostics. */
export function runnerDiagnosticsFeatureExtension(): { readonly policy_ack_direct: true } {
  return { policy_ack_direct: true };
}

export function supportsDirectPolicyDiagnostics(extensions: unknown): boolean {
  const value = extensionValue(extensions, RUNNER_DIAGNOSTICS_FEATURE_EXTENSION);
  return RunnerDiagnosticsFeaturesSchema.safeParse(value).success;
}

function extensionValue(extensions: unknown, key: string): unknown {
  if (typeof extensions !== "object" || extensions === null || Array.isArray(extensions)) return undefined;
  return (extensions as Record<string, unknown>)[key];
}

function noControlCharacters(value: string): boolean {
  return !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
