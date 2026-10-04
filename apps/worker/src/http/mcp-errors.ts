import { readCappedBytes } from "../body.js";

export type McpHandlerStage = "handler_dispatch" | "server_factory" | "sdk_transport";

/** Fixed SDK diagnostics; exception messages and stacks can contain MCP secrets. */
export function reportMcpHandlerError(error: unknown, stage: McpHandlerStage): void {
  const kind = error instanceof TypeError ? "type_error" : error instanceof RangeError ? "range_error"
    : error instanceof SyntaxError ? "syntax_error" : error instanceof DOMException && error.name === "AbortError" ? "abort_error"
      : error instanceof Error ? "error" : "other";
  // Exact literals from the installed Agents/MCP SDK. All variable exception
  // text remains private, including messages that only contain these phrases.
  let reason = "unknown";
  switch (error instanceof Error ? error.message : undefined) {
    case "Invalid verified OAuth request context": reason = "invalid_auth_context"; break;
    case "Conflicting verified OAuth client identity": reason = "conflicting_auth_context"; break;
    case "Cannot register capabilities after connecting to transport": reason = "already_connected"; break;
  }
  console.warn(`RUNMESH_MCP_HANDLER_ERROR kind=${kind} stage=${stage} reason=${reason}`);
}

/** Consume a bounded rejected upload and retain only its response correlation. */
export async function readRejectedMcpRequestId(request: Request): Promise<string | number | null> {
  // Cancelling an unread HTTP body can reset a reused transport connection.
  // Drain only a small bounded body; oversized or stalled uploads are cancelled
  // by the shared reader. This never dispatches a method or validates arguments.
  const bytes = await readCappedBytes(request, 16_384, 1_000);
  if (bytes === undefined) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const rpc = value as Record<string, unknown>;
    if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return null;
    return typeof rpc.id === "string" || (typeof rpc.id === "number" && Number.isFinite(rpc.id)) ? rpc.id : null;
  } catch { return null; }
}

/** Pre-SDK failures remain HTTP errors, with a parseable JSON-RPC body. */
export function mcpHttpError(status: number, message: string, id: string | number | null = null): Response {
  // A matching id lets clients settle an outstanding call instead of timing out.
  // Credential rejection keeps the same status and message for every identity.
  return Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message } }, {
    status, headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });
}
