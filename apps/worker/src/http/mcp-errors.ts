import { readCappedBytes } from "../body.js";

/** Finish small rejected uploads before replying, without an unbounded drain. */
export async function discardMcpBody(request: Request): Promise<void> {
  // Cancelling an unread HTTP body can reset a reused transport connection.
  // Drain only a small bounded body; oversized or stalled uploads are cancelled
  // by the shared reader. Never parse rejected request data or recover an id.
  await readCappedBytes(request, 16_384, 1_000);
}

/** Pre-SDK failures remain HTTP errors, with a parseable JSON-RPC body. */
export function mcpHttpError(status: number, message: string): Response {
  // Do not parse unauthenticated request bodies just to recover an RPC id.
  // All rejected credentials share the same status, message and null id.
  return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }, {
    status, headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    },
  });
}
