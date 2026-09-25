import type { CapturedIdentity } from "./identity.js";
export const CENTRAL_GOVERNANCE_LIMITS = Object.freeze({ calls_per_minute: 30, profile_calls_per_minute: 120,
  keys: 2048, receipts: 1000, retention_ms: 86_400_000, failures: 3, cooldown_ms: 30_000 });
export interface CentralReceipt { readonly request_id: string; readonly audit_status: "recorded" | "unavailable" }
export interface CentralObservation {
  /** Synchronous owner-local admission after live authorization; never queues. */
  admit(principal: CapturedIdentity, command: { readonly profile_id: string }): boolean;
  record(principal: CapturedIdentity, command: { readonly profile_id: string; readonly tool_id: string; readonly version: string },
    outcome: { readonly state: "completed" | "failed"; readonly operation_state: "not_started" | "completed" | "unknown"; readonly code?: string }): CentralReceipt;
}
export interface CentralAuditRow { readonly request_id: string; readonly client_id: string; readonly profile_id: string;
  readonly tool_id: string; readonly version: string; readonly operation_state: "not_started" | "completed" | "unknown";
  readonly code: string; readonly created_at_ms: number }
export interface CentralAuditAdministration { listCentralReceipts(hash: string): Promise<{ readonly state: "listed"; readonly receipts: readonly CentralAuditRow[] } | { readonly state: "denied" | "unavailable" }> }
