import { isRecord } from "./primitives.js";
import { isSafeNonnegativeInteger } from "./primitives.js";
import { safeJobIdentifier } from "./primitives.js";

export function safeRunnerContext(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  const runnerId = safeJobIdentifier(value.runner_id);
  if (runnerId !== undefined) output.runner_id = runnerId;
  if (value.state === "online" || value.state === "offline" || value.state === "stale" || value.state === "unavailable") output.state = value.state;
  if (typeof value.available === "boolean") output.available = value.available;
  if (value.updated_at_ms === null || isSafeNonnegativeInteger(value.updated_at_ms)) output.updated_at_ms = value.updated_at_ms;
  if (typeof value.automatic_selection === "boolean") output.automatic_selection = value.automatic_selection;
  return output;
}

/** Explicitly project sticky selection data; Registry responses are internal
 * and must not be spread into the public MCP response. */
export function safeSelectionValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { active_runner_id: null, active_runner_updated_at_ms: null, active_runner: null };
  return {
    active_runner_id: value.active_runner_id === null ? null : safeJobIdentifier(value.active_runner_id) ?? null,
    active_runner_updated_at_ms: value.active_runner_updated_at_ms === null || isSafeNonnegativeInteger(value.active_runner_updated_at_ms)
      ? value.active_runner_updated_at_ms
      : null,
    active_runner: value.runner === null ? null : safeRunnerContext(value.runner),
  };
}

export function safeJobIdentifierFromResult(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.structuredContent)) return undefined;
  const direct = safeJobIdentifier(value.structuredContent.job_id);
  if (direct !== undefined) return direct;
  const job = isRecord(value.structuredContent.job) ? value.structuredContent.job : undefined;
  return job === undefined ? undefined : safeJobIdentifier(job.job_id);
}

export function safeWorkspaceIdFromResult(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.structuredContent)) return null;
  const direct = safeJobIdentifier(value.structuredContent.workspace_id);
  if (direct !== undefined) return direct;
  const job = isRecord(value.structuredContent.job) ? value.structuredContent.job : undefined;
  return job === undefined ? null : safeJobIdentifier(job.workspace_id) ?? null;
}

export function safeRunnerContextFromResult(value: unknown): { readonly runner_id?: string } | undefined {
  if (!isRecord(value) || !isRecord(value.structuredContent)) return undefined;
  const direct = isRecord(value.structuredContent.runner_context) ? value.structuredContent.runner_context : undefined;
  if (direct !== undefined) {
    const runnerId = safeJobIdentifier(direct.runner_id);
    return runnerId === undefined ? undefined : { runner_id: runnerId };
  }
  const error = isRecord(value.structuredContent.error) ? value.structuredContent.error : undefined;
  const details = error !== undefined && isRecord(error.details) ? error.details : undefined;
  if (details === undefined || !isRecord(details.runner_context)) return undefined;
  const runnerId = safeJobIdentifier(details.runner_context.runner_id);
  return runnerId === undefined ? undefined : { runner_id: runnerId };
}

/** Public workspace metadata is intentionally smaller than the Registry row. */
export function safeWorkspaceMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const workspaceId = safeJobIdentifier(value.workspace_id);
  if (workspaceId === undefined || typeof value.enabled !== "boolean" || !isRecord(value.permissions)) return undefined;
  const permissions = value.permissions;
  if (typeof permissions.read !== "boolean" || typeof permissions.edit !== "boolean" || typeof permissions.shell !== "boolean" || typeof permissions.job_control !== "boolean") return undefined;
  return { workspace_id: workspaceId, enabled: value.enabled, permissions: { read: permissions.read, edit: permissions.edit, shell: permissions.shell, job_control: permissions.job_control } };
}
