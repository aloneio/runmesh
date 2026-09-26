import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CatalogPage, SharedProfiles } from "../../contracts/catalog.js";
import { CATALOG_LIMITS } from "../../contracts/catalog.js";
import { catalogDigest, catalogJson, catalogObject } from "../../contracts/catalog-json.js";
import { catalogPublicName, parseRemoteTool } from "../../contracts/catalog-values.js";
import { REMOTE_CODES, REMOTE_LIMITS, remoteFailureMetadata, type RemoteCode, type RemoteOutcome } from "../../contracts/remote.js";
import { parseRemoteResult } from "../../contracts/remote-values.js";

export interface RemoteToolPort {
  list(query: unknown): Promise<CatalogPage>;
  call(command: unknown): Promise<RemoteOutcome>;
}
const remoteFailure = (code: RemoteCode, operation_state: "not_started" | "completed" | "unknown") => ({ isError: true,
  content: [{ type: "text" as const, text: JSON.stringify({ error: remoteFailureMetadata(code, operation_state) }) }] });
async function bounded<T>(call: () => Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([call(), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]); }
  catch { return undefined; } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Thin provider only. HTTP composition injects ports; no Worker environment,
 * Runner selection, credential vault, storage or application implementation. */
export function registerRemoteTools(server: McpServer, port: RemoteToolPort & { profiles(): Promise<SharedProfiles> }): void {
  server.registerTool("remote_profiles", {
    description: "List shared MCP services with published tools. Use profile_id with remote_tools to discover every service, including libraries too large for direct tool listing.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const raw = await bounded(() => port.profiles(), 7000);
    const parsed = z.object({ state: z.literal("listed"), profiles: z.array(z.object({
      profile_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u), name: z.string().min(1).max(128),
    }).strict()).max(CATALOG_LIMITS.profiles) }).strict().safeParse(raw);
    if (!parsed.success) return remoteFailure(raw?.state === "denied" ? "permission_denied" : "dependency_unavailable", "not_started");
    return { content: [{ type: "text" as const, text: JSON.stringify(parsed.data) }] };
  });
  server.registerTool("remote_tools", {
    description: "List shared published remote MCP tools for a profile from remote_profiles. No Runner is needed. Use the returned tool_id and version with remote_call. This lists saved reviewed definitions, not live discovery.",
    inputSchema: z.object({ profile_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
      limit: z.number().int().min(1).max(CATALOG_LIMITS.page_tools).optional(), cursor: z.string().min(1).max(CATALOG_LIMITS.cursor_bytes).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { "runmesh/central_contract": 1 },
  }, async query => {
    const raw = await bounded(() => port.list(query), 7000);
    if (raw === undefined || catalogJson(raw, CATALOG_LIMITS.snapshot_bytes) === undefined) return remoteFailure("dependency_unavailable", "not_started");
    if (raw.state !== "listed") return remoteFailure(raw.state === "denied" ? "permission_denied" : raw.state === "invalid" ? "invalid_request"
      : raw.state === "stale_cursor" ? "stale_catalog" : "dependency_unavailable", "not_started");
    if (!Array.isArray(raw.tools) || raw.tools.length > CATALOG_LIMITS.page_tools
      || (raw.next_cursor !== null && (typeof raw.next_cursor !== "string" || raw.next_cursor.length > CATALOG_LIMITS.cursor_bytes))) return remoteFailure("dependency_unavailable", "not_started");
    const tools = [];
    for (const entry of raw.tools) {
      const tool = catalogObject(entry), definition = parseRemoteTool(tool?.definition);
      if (tool === undefined || definition === undefined || typeof tool.tool_id !== "string" || !/^mcp\.[a-f0-9]{64}$/u.test(tool.tool_id)
        || !catalogDigest(tool.version) || tool.public_name !== catalogPublicName(query.profile_id, definition.name, tool.tool_id.slice(4))) return remoteFailure("dependency_unavailable", "not_started");
      tools.push({ tool_id: tool.tool_id, public_name: tool.public_name, version: tool.version, definition });
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ tools, next_cursor: raw.next_cursor }) }] };
  });
  server.registerTool("remote_call", {
    description: "Invoke exactly one approved remote MCP tool using profile_id, tool_id and version from remote_tools. Arguments follow that tool's reviewed inputSchema. No Runner or machine permission is implied. Never repeat an unknown outcome blindly; upstream writes are never automatically retried.",
    inputSchema: z.object({ profile_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
      tool_id: z.string().regex(/^mcp\.[a-f0-9]{64}$/u), version: z.string().regex(/^[a-f0-9]{64}$/u),
      arguments: z.record(z.string(), z.unknown()) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { "runmesh/central_contract": 1 },
  }, async command => {
    return invokeRemote(port, command);
  });
}

export async function invokeRemote(port: RemoteToolPort, command: unknown) {
    const raw = await bounded(() => port.call(command), REMOTE_LIMITS.operation_ms + 2000);
    const receipt = raw?.receipt && /^[a-f0-9-]{36}$/u.test(raw.receipt.request_id) && ["recorded", "unavailable"].includes(raw.receipt.audit_status)
      ? { "runmesh/receipt": { request_id: raw.receipt.request_id, audit_status: raw.receipt.audit_status } } : {};
    if (raw?.state === "completed" && raw.operation_state === "completed") {
      const result = parseRemoteResult(raw.result);
      if (result !== undefined) return { ...result, _meta: { "runmesh/operation_state": "completed", ...receipt } } as unknown as { content: Array<{ type: "text"; text: string }>; isError: boolean };
    }
    if (raw?.state === "failed" && REMOTE_CODES.includes(raw.code as RemoteCode) && ["not_started", "completed", "unknown"].includes(raw.operation_state))
      return { ...remoteFailure(raw.code, raw.operation_state), ...(raw.receipt ? { _meta: receipt } : {}) };
    return remoteFailure("result_unconfirmed", "unknown");
}
