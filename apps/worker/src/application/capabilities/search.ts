import { parseCatalogHead } from "../../contracts/catalog-values.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";
import { catalogRevision } from "../../contracts/catalog-json.js";
import { capturedIdentityState, type CapturedIdentity } from "../../contracts/identity.js";
import { TOOL_SEARCH_LIMITS, parseToolSearchQuery, type ToolSearchPorts, type ToolSearchResult } from "../../contracts/tool-search.js";
import { compatibleApprovedTools, verifiedCatalogSnapshot } from "../../domain/capabilities/catalog.js";
import { createToolSearchRanking, createToolSearchScorer, toolSearchDescription } from "../../domain/capabilities/tool-search.js";
import { publishedProfiles } from "./published-profiles.js";

class SearchCapacity extends Error {}

/** Search the current published snapshots with bounded top-k memory and no upstream port. */
export function createToolSearcher(ports: ToolSearchPorts) {
  return async (principal: CapturedIdentity, input: unknown, signal: AbortSignal, expired: () => boolean): Promise<ToolSearchResult> => {
    const query = parseToolSearchQuery(input);
    if (!query || !isCapabilityIdentifier(principal?.client_id) || !catalogRevision(principal.secret_version)) return { state: "invalid" };
    const stopped = () => signal.aborted || expired();
    const authorize = async (): Promise<"allowed" | "denied" | "unavailable"> => {
      if (stopped()) return "unavailable";
      const decision = await ports.identity(principal, signal);
      if (stopped()) return "unavailable";
      return capturedIdentityState(principal, decision);
    };
    try {
      const first = await authorize();
      if (first !== "allowed") return { state: first };
      const publication = publishedProfiles(ports), ranking = createToolSearchRanking(query.limit ?? TOOL_SEARCH_LIMITS.default_results), scoreTool = createToolSearchScorer(query.query);
      let bytes = 0, toolCount = 0;
      const digest = async (canonical: string): Promise<string> => {
        bytes += new TextEncoder().encode(canonical).byteLength;
        if (bytes > TOOL_SEARCH_LIMITS.scan_bytes) throw new SearchCapacity();
        if (stopped()) throw new Error("search_expired");
        return ports.digest(canonical);
      };
      for (const { profile, catalog_revision } of publication) {
        if (stopped()) return { state: "unavailable" };
        if (query.profile_id !== undefined && profile.profile_id !== query.profile_id) continue;
        const head = parseCatalogHead(ports.repository.readHead(profile.profile_id));
        if (!head || head.profile_id !== profile.profile_id || head.revision !== catalog_revision || !head.approved_digest) return { state: "stale_catalog" };
        const observed = ports.repository.readSnapshot(profile.profile_id, head.observed_digest),
          approved = head.observed_digest === head.approved_digest ? observed : ports.repository.readSnapshot(profile.profile_id, head.approved_digest);
        if (!observed || !approved || !await verifiedCatalogSnapshot(observed, profile, head.observed_digest, digest)) return { state: "unavailable" };
        if (stopped()) return { state: "unavailable" };
        if (observed !== approved && !await verifiedCatalogSnapshot(approved, profile, head.approved_digest, digest)) return { state: "unavailable" };
        if (stopped()) return { state: "unavailable" };
        const approvedNames = new Set(approved.tools.map(tool => tool.definition.name));
        if (head.approved_names.some(name => !approvedNames.has(name))) return { state: "unavailable" };
        for (const tool of compatibleApprovedTools(observed, approved, head.approved_names)) {
          if (stopped()) return { state: "unavailable" };
          if (++toolCount > TOOL_SEARCH_LIMITS.scan_tools) return { state: "capacity" };
          const profile_name = profile.display_name ?? profile.connector_id,
            score = scoreTool({ ...tool.definition, profile_name });
          if (score > 0) ranking.offer(score, { profile_id: profile.profile_id, profile_name,
            profile_revision: profile.revision, catalog_revision, tool_id: tool.tool_id, version: tool.version,
            name: tool.definition.name, description: toolSearchDescription(tool.definition.description) });
        }
      }
      const final = await authorize();
      if (final !== "allowed") return { state: final };
      if (JSON.stringify(publishedProfiles(ports)) !== JSON.stringify(publication)) return { state: "stale_catalog" };
      return { state: "listed", tools: ranking.results() };
    } catch (error) { return { state: error instanceof SearchCapacity ? "capacity" : "unavailable" }; }
  };
}
