/** Do not commit HTTP success while the SDK has yet to produce any SSE bytes.
 * A termination before those bytes cannot leave an already committed empty 200.
 * The remainder still streams with backpressure; no result buffering or retry.
 */
export async function primeMcpResponse(response: Response, parsedBody: unknown): Promise<Response> {
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const reader = response.body?.getReader();
  let first: ReadableStreamReadResult<Uint8Array> | undefined;
  try {
    do { first = await reader?.read(); } while (first && !first.done && first.value.byteLength === 0);
  } catch { return unavailable("stream_error"); }
  if (!first || first.done) return unavailable("empty_stream");
  const initial = first.value;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(initial); },
    async pull(controller) {
      try {
        const next = await reader!.read();
        if (next.done) { reader!.releaseLock(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { reader!.releaseLock(); controller.error(error); }
    },
    async cancel(reason) {
      try { await reader!.cancel(reason); } finally { reader!.releaseLock(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });

  async function unavailable(reason: "empty_stream" | "stream_error"): Promise<Response> {
    try { await reader?.cancel(); } catch { /* The failed source may already be closed. */ }
    finally { reader?.releaseLock(); }
    // Platform invocation logs supply correlation. Do not log arguments, IDs,
    // URLs or exception messages, which can contain client credentials.
    console.warn({ event: "mcp_response_unavailable", reason });
    const rpc = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody) ? parsedBody as Record<string, unknown> : undefined;
    const id = typeof rpc?.id === "string" || (typeof rpc?.id === "number" && Number.isFinite(rpc.id)) ? rpc.id : null;
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: "The MCP response ended before a result was received. The operation outcome is unknown; check its state before retrying." } }, { status: 502, headers });
  }
}
