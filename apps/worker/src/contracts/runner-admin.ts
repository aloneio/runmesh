import type { RunnerExecutionMode } from "./administration.js";

export type ConsoleExecutionMode = RunnerExecutionMode;

export type ExecutionModeSelection = { readonly mode: ConsoleExecutionMode; readonly confirmed: boolean };

export type RunnerExecutionSnapshot = {
  readonly runner: Record<string, unknown>;
  readonly configuredMode: ConsoleExecutionMode | null;
  readonly lifecycleId: string;
};

export type RunnerExecutionSnapshotResult = { readonly status: number; readonly snapshot?: RunnerExecutionSnapshot };

export type RunnerExecutionExpectation = { readonly configuredMode: ConsoleExecutionMode | null; readonly lifecycleId: string };

export type EnrollmentWindow = { readonly not_before_ms?: number; readonly expires_at_ms?: number };

export type EnrollmentCodeResult =
  | { readonly ok: true; readonly code: string; readonly created_at_ms: number; readonly not_before_ms: number; readonly expires_at_ms: number }
  | { readonly ok: false; readonly status: number; readonly deterministic: boolean };
