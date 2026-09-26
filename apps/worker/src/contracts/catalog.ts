import type { CapturedIdentity, IdentityDecision } from "./identity.js";
import type { AdminDecision, ConnectionProfile } from "./connectors.js";

/** Safety ceilings for imported descriptions, not capacity or latency promises. */
export const CATALOG_LIMITS = Object.freeze({ tools: 128, tool_bytes: 32_768, snapshot_bytes: 524_288,
  request_bytes: 524_288, depth: 16, nodes: 8_192, page_tools: 20, profiles: 200,
  versions_per_profile: 32, snapshots: 512, storage_bytes: 16_777_216, cursor_bytes: 2_048, cursor_ttl_ms: 300_000 });
export type CatalogJson = null | boolean | number | string | CatalogJson[] | { [key: string]: CatalogJson };
export interface RemoteToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: { [key: string]: CatalogJson };
  readonly outputSchema?: { [key: string]: CatalogJson };
  readonly annotations?: { readonly title?: string; readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean; readonly openWorldHint?: boolean };
}
export interface CatalogTool {
  readonly tool_id: string;
  readonly public_name: string;
  readonly version: string;
  readonly definition: RemoteToolDefinition;
}
export interface CatalogSnapshot {
  readonly schema_version: 1;
  readonly profile_id: string;
  readonly connector_id: string;
  readonly endpoint: string;
  readonly digest: string;
  readonly tools: readonly CatalogTool[];
}
export interface CatalogHead {
  readonly schema_version: 1;
  readonly profile_id: string;
  readonly revision: number;
  readonly observed_digest: string;
  readonly approved_digest: string | null;
  readonly approved_names: readonly string[];
}
export type CatalogCommand =
  | { readonly action: "stage"; readonly profile_id: string; readonly expected_revision: number; readonly tools: readonly RemoteToolDefinition[] }
  | { readonly action: "approve"; readonly profile_id: string; readonly expected_revision: number; readonly digest: string; readonly tool_names: readonly string[] }
  | { readonly action: "disable"; readonly profile_id: string; readonly expected_revision: number };
export type CatalogFailure = { readonly state: "invalid" | "missing" | "denied" | "unavailable" | "unknown" | "capacity" | "stale_profile" };
export type CatalogMutation = { readonly state: "written"; readonly head: CatalogHead }
  | { readonly state: "conflict"; readonly current_revision: number } | CatalogFailure;
export interface CatalogRepository {
  readHead(profileId: string): CatalogHead | undefined;
  readSnapshot(profileId: string, digest: string): CatalogSnapshot | undefined;
  stage(snapshot: CatalogSnapshot, expectedRevision: number): CatalogMutation;
  approve(profileId: string, digest: string, toolNames: readonly string[], expectedRevision: number): CatalogMutation;
  disable(profileId: string, expectedRevision: number): CatalogMutation;
}
export interface CatalogAdminPorts {
  readonly repository: CatalogRepository;
  readonly profile: (profileId: string) => ConnectionProfile | undefined;
  readonly authorize: (signal: AbortSignal) => Promise<AdminDecision>;
  readonly digest: (canonical: string) => Promise<string>;
}
export interface CatalogDelta { readonly name: string; readonly state: "added" | "changed" | "removed" | "unchanged" }
export type CatalogInspection = { readonly state: "found"; readonly head: CatalogHead; readonly snapshot: CatalogSnapshot;
  readonly changes: readonly CatalogDelta[] } | CatalogFailure;
export interface CatalogCursor {
  readonly schema_version: 2;
  readonly client_id: string;
  readonly secret_version: number;
  readonly profile_id: string;
  readonly profile_revision: number;
  readonly catalog_revision: number;
  readonly offset: number;
  readonly limit: number;
  readonly expires_at_ms: number;
}
export interface CatalogCursorCodec {
  seal(cursor: CatalogCursor): Promise<string>;
  open(value: string): Promise<CatalogCursor | undefined>;
}
export interface CatalogQuery { readonly profile_id: string; readonly limit?: number; readonly cursor?: string }
export type CatalogPage = { readonly state: "listed"; readonly tools: readonly CatalogTool[]; readonly next_cursor: string | null }
  | { readonly state: "denied" | "unavailable" | "invalid" | "stale_cursor" };
export interface CatalogReadPorts {
  readonly repository: CatalogRepository;
  readonly profile: (profileId: string) => ConnectionProfile | undefined;
  readonly identity: (principal: CapturedIdentity, signal: AbortSignal) => Promise<IdentityDecision>;
  readonly digest: (canonical: string) => Promise<string>;
  readonly cursor: CatalogCursorCodec;
  readonly now: () => number;
}
export interface CatalogAdministration {
  mutateCatalog(sessionHash: string, command: unknown): Promise<CatalogMutation>;
  getCatalog(sessionHash: string, profileId: string, digest?: string): Promise<CatalogInspection>;
}
export type CentralDirectory = { readonly state: "listed"; readonly view_version: string; readonly tools: readonly (CatalogTool & { readonly profile_id: string })[] }
  | { readonly state: "denied" | "unavailable" | "capacity" };
export interface CentralDirectoryReader { listDirectory(principal: CapturedIdentity): Promise<CentralDirectory> }
export type SharedProfiles = { readonly state: "listed"; readonly profiles: readonly { readonly profile_id: string; readonly name: string }[] }
  | { readonly state: "denied" | "unavailable" };
export interface DirectoryReadPorts extends CatalogReadPorts {
  readonly profiles: (after: string) => { readonly profiles: readonly ConnectionProfile[]; readonly next_after: string | null };
}
