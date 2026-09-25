import type { RunnerExecutionMode, CodingScope } from "./administration.js";

/** Display contracts, deliberately independent of Registry rows and facades. */
export interface RunnerSummaryViewModel {
  readonly runner_id: string;
  readonly display_name: string;
  readonly state: string;
  readonly last_heartbeat_ms: number | null;
  readonly configured_execution_mode: RunnerExecutionMode | null;
  readonly public_info: { readonly platform: string; readonly architecture: string } | null;
  readonly active_job_count?: number;
}
export interface ClientViewModel {
  readonly client_id: string;
  readonly label: string;
  readonly scopes: readonly CodingScope[];
  readonly revoked_at_ms: number | null;
  readonly last_used_at_ms: number | null;
  readonly active_runner_id: string | null;
  readonly record_jobs?: boolean;
}
export type AdminNotice = { readonly title: string; readonly message: string; readonly code?: string };
export type DashboardViewModel = {
  readonly runners?: readonly RunnerSummaryViewModel[];
  readonly jobs?: readonly Record<string, unknown>[];
};
export type AdminData = {
  readonly clients: readonly ClientViewModel[];
  readonly runners: readonly RunnerSummaryViewModel[];
  readonly jobs: readonly Record<string, unknown>[];
  readonly snapshot: DashboardViewModel;
  readonly notices: readonly AdminNotice[];
};
export type ControlNavSection = "dashboard" | "runners" | "clients" | "settings" | "central";
