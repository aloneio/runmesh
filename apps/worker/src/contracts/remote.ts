import type { CatalogJson, CatalogMutation, CatalogPage, CatalogReadPorts, RemoteToolDefinition } from "./catalog.js";
import type { CapturedIdentity } from "./identity.js";
import type { ConnectionProfile } from "./connectors.js";
import type { CentralObservation, CentralReceipt } from "./central-audit.js";

/** Per-operation safety bounds, not advertised production capacity. */
export const REMOTE_LIMITS = Object.freeze({ operation_ms: 20_000, request_bytes: 65_536, response_bytes: 1_048_576,
  aggregate_bytes: 2_097_152, fragments: 4096, events: 256, requests: 12, pages: 8, content_items: 32,
  active: 2, per_client: 1, policies: 64, policy_bytes: 16_384, validation_cost: 1_000_000 });
export type RemoteProtocol = "2026-07-28" | "2025-11-25";
export interface RemoteEgressRule { readonly endpoint: string; readonly protocol: RemoteProtocol; readonly session?: "ephemeral" }
export interface RemoteCall {
  readonly profile_id: string;
  readonly tool_id: string;
  readonly version: string;
  readonly arguments: { [key: string]: CatalogJson };
}
export interface RemoteResult {
  readonly content: readonly { [key: string]: CatalogJson }[];
  readonly structuredContent?: { [key: string]: CatalogJson };
  readonly isError: boolean;
}
export const REMOTE_CODES = Object.freeze(["invalid_request", "invalid_arguments", "permission_denied", "authorization_required", "stale_catalog",
  "dependency_unavailable", "egress_denied", "upstream_unavailable", "upstream_protocol_error",
  "unsupported_interaction", "result_invalid", "result_withheld", "result_unconfirmed", "operation_timed_out", "busy"] as const);
export type RemoteCode = (typeof REMOTE_CODES)[number];
const remoteClasses: Readonly<Record<RemoteCode, string>> = Object.freeze({ invalid_request: "validation", invalid_arguments: "validation",
  permission_denied: "authorization", authorization_required: "authorization", stale_catalog: "conflict", dependency_unavailable: "availability", egress_denied: "authorization",
  upstream_unavailable: "availability", upstream_protocol_error: "protocol", unsupported_interaction: "unsupported",
  result_invalid: "protocol", result_withheld: "authorization", result_unconfirmed: "unknown", operation_timed_out: "availability", busy: "capacity" });

/** Central effects have no Runner Job receipt. Keep their error vocabulary
 * separate from the native wire catalog and never turn uncertainty into replay. */
export function remoteFailureMetadata(value: unknown, observed: unknown) {
  const code: RemoteCode = typeof value === "string" && REMOTE_CODES.includes(value as RemoteCode) ? value as RemoteCode : "result_unconfirmed";
  const operation_state = code === "result_unconfirmed" || !["not_started", "completed", "unknown"].includes(observed as string)
    ? "unknown" : observed as "not_started" | "completed" | "unknown";
  return Object.freeze({ code: `remote_${code}`, failure_class: remoteClasses[code], operation_state,
    next_action: operation_state !== "not_started" ? "inspect_upstream_state" : code === "stale_catalog" ? "refresh_approved_catalog" : "check_central_configuration",
    recovery_hint: operation_state === "unknown" ? "The upstream action may have executed. Inspect its state before a new invocation; this call was not replayed."
      : operation_state === "completed" ? "The upstream action completed, but its result cannot be returned. Do not treat this response as a rollback."
      : "Check the central connection, approved catalog and client grant before a new request." });
}
export type RemoteFailure = { readonly state: "failed"; readonly code: RemoteCode;
  readonly operation_state: "not_started" | "completed" | "unknown" };
export type RemoteOutcome = ({ readonly state: "completed"; readonly operation_state: "completed"; readonly result: RemoteResult } | RemoteFailure) & { readonly receipt?: CentralReceipt };

/** No URLs, headers, tokens, sessions, Runner selection or SDK types in the call port. */
export interface RemoteSession {
  listTools(): Promise<readonly RemoteToolDefinition[]>;
  callTool(tool: RemoteToolDefinition, args: { [key: string]: CatalogJson }, beforeDispatch: () => Promise<void>): Promise<RemoteResult>;
  close(): Promise<void>;
}
export interface RemoteConnector {
  open(profile: ConnectionProfile, signal: AbortSignal, dispatched: () => void, authorize: () => Promise<void>): Promise<RemoteSession>;
  validate(schema: { [key: string]: CatalogJson }, value: unknown): boolean;
}
export type RemoteCallPorts = Omit<CatalogReadPorts, "cursor" | "now"> & { readonly connector: RemoteConnector; readonly observation?: CentralObservation };
export interface CentralRemote {
  listCatalog(principal: CapturedIdentity, query: unknown): Promise<CatalogPage>;
  callRemote(principal: CapturedIdentity, command: unknown): Promise<RemoteOutcome>;
  discoverRemote(sessionHash: string, profileId: string, expectedRevision: number, principal?: CapturedIdentity): Promise<CatalogMutation | RemoteFailure>;
}

/** Fixed codes only. Untrusted exception messages are never carried across ports. */
export class RemoteFault extends Error {
  public constructor(public readonly code: RemoteCode) { super(code); this.name = "RemoteFault"; }
}
