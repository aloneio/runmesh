export type RunnerConnectionState = "online" | "offline" | "stale";
export const RUNNER_PRESENCE_TIMEOUT_MS = 45_000;

/** Read-time presence remains accurate when the maintenance alarm is delayed. */
export function observedRunnerState(state: RunnerConnectionState, lastHeartbeatMs: number | null, nowMs: number): RunnerConnectionState {
  return state === "online" && (lastHeartbeatMs === null || lastHeartbeatMs < nowMs - RUNNER_PRESENCE_TIMEOUT_MS)
    ? "stale" : state;
}

export type AppliedPolicyIdentity = {
  readonly applied_revision: number;
  readonly active_checksum: string;
};

/** The desired, applied and Runner-reported identities must agree before use. */
export function appliedPolicyIdentity(value: unknown): AppliedPolicyIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const revision = candidate.applied_revision, checksum = candidate.active_checksum;
  if (candidate.ok !== true || candidate.policy_status !== "applied"
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1
    || typeof checksum !== "string" || !/^[a-f0-9]{64}$/u.test(checksum)
    || candidate.desired_revision !== revision || candidate.runner_reported_policy_revision !== revision
    || candidate.desired_checksum !== checksum || candidate.runner_reported_policy_checksum !== checksum) return undefined;
  return { applied_revision: revision, active_checksum: checksum };
}
export type PolicyReadiness =
  | {
      readonly ok: true;
      readonly policy_status: "applied";
      readonly desired_revision: number;
      readonly desired_checksum: string;
      readonly applied_revision: number;
      readonly active_checksum: string;
      readonly runner_reported_policy_revision: number;
      readonly runner_reported_policy_checksum: string;
      readonly connection_epoch: number;
      readonly credential_version: number;
      /** Opaque runner-id lifecycle identity for transport fencing. */
      readonly lifecycle_id: string | null;
      readonly session_id: string;
    }
  | { readonly ok: false; readonly code: "policy_pending" | "stale_policy"; readonly reason: string };
export interface ActiveRunnerContext {
  readonly runner_id: string;
  readonly state: RunnerConnectionState | "unavailable";
  readonly available: boolean;
  readonly updated_at_ms: number | null;
}
export interface McpClientActiveRunner {
  readonly active_runner_id: string | null;
  readonly active_runner_updated_at_ms: number | null;
  readonly runner: ActiveRunnerContext | null;
}
export type McpRunnerSelectionResult =
  | { readonly ok: true; readonly selection: McpClientActiveRunner; readonly changed: boolean }
  | { readonly ok: false; readonly code: "client_not_found" | "runner_not_found" | "runner_unavailable" | "runner_switch_confirmation_required"; readonly selection?: McpClientActiveRunner };
