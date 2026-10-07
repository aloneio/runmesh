import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { remoteFailureMetadata } from "../../../contracts/remote.js";
import { TOOL_SEARCH_LIMITS, parseToolSearchQuery, parseToolSearchResult, type ToolSearchResult } from "../../../contracts/tool-search.js";
import { publishSchema } from "../schema-publication.js";

const input = publishSchema(z.object({ query: z.string().min(1).max(TOOL_SEARCH_LIMITS.query_bytes),
  profile_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).optional(),
  limit: z.number().int().min(1).max(TOOL_SEARCH_LIMITS.results).optional() }).strict(), "input");
export interface RemoteSearchPort { search(query: unknown): Promise<ToolSearchResult> }
async function boundedSearch(port: RemoteSearchPort, query: unknown): Promise<ToolSearchResult | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([port.search(query), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 7000); })]); }
  catch { return undefined; } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function registerRemoteSearchTool(server: McpServer, port: RemoteSearchPort): void {
  server.registerTool("remote_search", {
    description: "Search published MCP tools by keywords in their names, descriptions and connection names. Results include profile_id, tool_id and version; use remote_tools for the full input schema.",
    inputSchema: input, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { "runmesh/central_contract": 1 },
  }, async value => {
    const query = parseToolSearchQuery(value), result = query ? parseToolSearchResult(await boundedSearch(port, query), query.limit ?? TOOL_SEARCH_LIMITS.default_results) : { state: "invalid" as const };
    if (result?.state === "listed") return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    const code = result?.state === "denied" ? "permission_denied" : result?.state === "invalid" ? "invalid_request"
      : result?.state === "stale_catalog" ? "stale_catalog" : result?.state === "capacity" ? "busy" : "dependency_unavailable";
    const error = { ...remoteFailureMetadata(code, "not_started"), ...(result?.state === "capacity"
      ? { next_action: "narrow_search", recovery_hint: "Search one MCP connection at a time by supplying profile_id." } : {}) };
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error }) }] };
  });
}
