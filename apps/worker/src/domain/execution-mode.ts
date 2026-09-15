import type { ConsoleExecutionMode } from "../contracts/runner-admin.js";
import { record } from "../values.js";
import type { RunnerExecutionSnapshot } from "../contracts/runner-admin.js";

export const DAY_MS = 24 * 60 * 60 * 1_000;

export const MAX_VALIDITY_DAYS = 3_650;

export function expectedConfiguredMode(snapshot: RunnerExecutionSnapshot): ConsoleExecutionMode | null {
  return snapshot.configuredMode;
}

/**
 * Read the server-owned administrator choice. `metadata` and `public_info`
 * are Runner-authored values, so they remain diagnostics only and can never
 * authorize a privileged installation. A null value means the record is not
 * ready for an administrative action until a mode is selected.
 */
export function runnerConfiguredExecutionMode(_runner: { readonly configured_execution_mode?: unknown; readonly metadata?: unknown; readonly public_info?: unknown }): ConsoleExecutionMode | null {
  return _runner.configured_execution_mode === "dedicated_user" || _runner.configured_execution_mode === "privileged_host"
    ? _runner.configured_execution_mode : null;
}

/** Runner-authored evidence is useful for diagnostics, but is not config. */
export function runnerReportedExecutionMode(runner: { readonly metadata?: unknown; readonly public_info?: unknown }): ConsoleExecutionMode | "unknown" {
  const metadata = record(runner.metadata);
  if (metadata?.execution_mode === "dedicated_user" || metadata?.execution_mode === "privileged_host") return metadata.execution_mode;
  const info = record(runner.public_info);
  if (info?.execution_mode === "dedicated_user" || info?.execution_mode === "privileged_host") return info.execution_mode;
  return "unknown";
}
