import { CATALOG_LIMITS, type DirectoryReadPorts } from "./catalog.js";
import { catalogDigest, catalogKeys, catalogObject, catalogRevision, toolName } from "./catalog-json.js";
import { isCapabilityIdentifier } from "./capabilities.js";
import type { CapturedIdentity } from "./identity.js";

export const TOOL_SEARCH_LIMITS = Object.freeze({ query_bytes: 256, default_results: 10, results: 20,
  description_chars: 512, scan_bytes: CATALOG_LIMITS.storage_bytes, scan_tools: CATALOG_LIMITS.profiles * CATALOG_LIMITS.tools });

export interface ToolSearchQuery { readonly query: string; readonly profile_id?: string; readonly limit?: number }
export interface ToolSearchEntry {
  readonly profile_id: string;
  readonly profile_name: string;
  readonly profile_revision: number;
  readonly catalog_revision: number;
  readonly tool_id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
}
export type ToolSearchResult = { readonly state: "listed"; readonly tools: readonly ToolSearchEntry[] }
  | { readonly state: "denied" | "unavailable" | "invalid" | "stale_catalog" | "capacity" };
export type ToolSearchPorts = Pick<DirectoryReadPorts, "repository" | "profiles" | "identity" | "digest">;
export interface CentralToolSearch {
  searchRemoteTools(principal: CapturedIdentity, query: unknown): Promise<ToolSearchResult>;
}

export function parseToolSearchQuery(value: unknown): ToolSearchQuery | undefined {
  const item = catalogObject(value);
  if (!item || !catalogKeys(item, ["query", "profile_id", "limit"]) || typeof item.query !== "string"
    || item.query.length > TOOL_SEARCH_LIMITS.query_bytes || new TextEncoder().encode(item.query).byteLength > TOOL_SEARCH_LIMITS.query_bytes
    || !/[\p{L}\p{N}]/u.test(item.query) || (item.profile_id !== undefined && !isCapabilityIdentifier(item.profile_id))
    || (item.limit !== undefined && (!Number.isSafeInteger(item.limit) || (item.limit as number) < 1 || (item.limit as number) > TOOL_SEARCH_LIMITS.results))) return undefined;
  return { query: item.query.trim(), ...(item.profile_id === undefined ? {} : { profile_id: item.profile_id as string }),
    ...(item.limit === undefined ? {} : { limit: item.limit as number }) };
}

/** Explicit result projection keeps transport metadata and schemas out of search responses. */
export function parseToolSearchResult(value: unknown, limit: number = TOOL_SEARCH_LIMITS.results): ToolSearchResult | undefined {
  const item = catalogObject(value);
  if (!item) return undefined;
  if (item.state !== "listed") return ["denied", "unavailable", "invalid", "stale_catalog", "capacity"].includes(item.state as string)
    ? { state: item.state as Exclude<ToolSearchResult["state"], "listed"> } : undefined;
  if (!Array.isArray(item.tools) || item.tools.length > limit || item.tools.length > TOOL_SEARCH_LIMITS.results) return undefined;
  const tools: ToolSearchEntry[] = [], seen = new Set<string>();
  for (const raw of item.tools) {
    const entry = catalogObject(raw);
    if (!entry || !isCapabilityIdentifier(entry.profile_id) || typeof entry.profile_name !== "string" || !entry.profile_name.trim()
      || entry.profile_name.length > 128 || !catalogRevision(entry.profile_revision) || !catalogRevision(entry.catalog_revision)
      || typeof entry.tool_id !== "string" || !/^mcp\.[a-f0-9]{64}$/u.test(entry.tool_id) || !catalogDigest(entry.version)
      || !toolName(entry.name) || typeof entry.description !== "string" || entry.description.length > TOOL_SEARCH_LIMITS.description_chars) return undefined;
    const key = `${entry.profile_id}/${entry.tool_id}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    tools.push({ profile_id: entry.profile_id, profile_name: entry.profile_name, profile_revision: entry.profile_revision,
      catalog_revision: entry.catalog_revision, tool_id: entry.tool_id, version: entry.version, name: entry.name, description: entry.description });
  }
  return { state: "listed", tools };
}
