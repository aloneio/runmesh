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
