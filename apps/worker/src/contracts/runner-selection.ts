export type RunnerConnectionState = "online" | "offline" | "stale";
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
