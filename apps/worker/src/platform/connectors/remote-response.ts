import { catalogJson, catalogObject } from "../../contracts/catalog-json.js";
import { REMOTE_LIMITS, RemoteFault } from "../../contracts/remote.js";

/** Reject excessive depth before JSON.parse or SDK recursive wire validation. */
export function boundedWireJson(text: string): Record<string, unknown> {
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") { if (++depth > 16) throw new RemoteFault("upstream_protocol_error"); }
    else if (char === "}" || char === "]") { if (--depth < 0) throw new RemoteFault("upstream_protocol_error"); }
  }
  if (quoted || depth !== 0) throw new RemoteFault("upstream_protocol_error");
  try {
    const value: unknown = JSON.parse(text);
    if (catalogJson(value, REMOTE_LIMITS.response_bytes) === undefined || catalogObject(value) === undefined) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new RemoteFault("upstream_protocol_error"); }
}

/** Request-scoped JSON/SSE guard. Only a final response for the outbound ID is
 * handed to the SDK. Progress/log frames are discarded, never stored. Reads end
 * at the final SSE response, not at an untrusted peer's optional EOF. */
export async function guardedRemoteResponse(response: Response, id: string | number, signal: AbortSignal,
  account: (bytes: number) => void): Promise<Response> {
  const cancelBody = () => { void response.body?.cancel().catch(() => undefined); };
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const size = response.headers.get("content-length");
  if (!response.ok || response.status !== 200 || !["application/json", "text/event-stream"].includes(type ?? "")
    || (size !== null && (!/^\d+$/u.test(size) || Number(size) > REMOTE_LIMITS.response_bytes))
    || response.headers.has("mcp-session-id")) { cancelBody(); throw new RemoteFault("upstream_protocol_error"); }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new RemoteFault("upstream_protocol_error");
  let stopped = false, bytes = 0, fragments = 0, events = 0, pending = "", data: string[] = [], eventBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { stopped = true; void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const frame = (text: string): Record<string, unknown> | undefined => {
    if (++events > REMOTE_LIMITS.events) throw new RemoteFault("upstream_protocol_error");
    const value = boundedWireJson(text);
    if (value.jsonrpc !== "2.0") throw new RemoteFault("upstream_protocol_error");
    if (value.method !== undefined) {
      if (value.id !== undefined || !["notifications/progress", "notifications/message"].includes(value.method as string))
        throw new RemoteFault("unsupported_interaction");
      return undefined;
    }
    if (value.id !== id || (Object.hasOwn(value, "result") === Object.hasOwn(value, "error"))) throw new RemoteFault("upstream_protocol_error");
    const result = catalogObject(value.result);
    if (result?.resultType === "input_required" || result?.inputRequests !== undefined || result?.task !== undefined)
      throw new RemoteFault("unsupported_interaction");
    return value;
  };
  const finish = (value: Record<string, unknown>) => new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }, status: 200 });
  try {
    while (true) {
      if (signal.aborted || stopped) throw new RemoteFault("operation_timed_out");
      const chunk = await reader.read();
      if (signal.aborted || stopped) throw new RemoteFault("operation_timed_out");
      if (++fragments > REMOTE_LIMITS.fragments) throw new RemoteFault("upstream_protocol_error");
      if (!chunk.done) {
        bytes += chunk.value.byteLength; account(chunk.value.byteLength);
        if (bytes > REMOTE_LIMITS.response_bytes) throw new RemoteFault("upstream_protocol_error");
      }
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (type === "application/json") {
        if (!chunk.done) continue;
        const value = frame(pending);
        if (value === undefined) throw new RemoteFault("upstream_protocol_error");
        return finish(value);
      }
      while (true) {
        const end = pending.search(/[\r\n]/u);
        if (end < 0 || (!chunk.done && pending[end] === "\r" && end === pending.length - 1)) break;
        const line = pending.slice(0, end); pending = pending.slice(end + (pending.slice(end, end + 2) === "\r\n" ? 2 : 1));
        if (line === "") {
          if (data.length) { const value = frame(data.join("\n")); data = []; eventBytes = 0; if (value !== undefined) return finish(value); }
        } else if (line.startsWith("data:")) {
          const part = line.slice(5).replace(/^ /u, ""); eventBytes += part.length;
          if (eventBytes > REMOTE_LIMITS.response_bytes || data.length >= REMOTE_LIMITS.events * 16) throw new RemoteFault("upstream_protocol_error");
          data.push(part);
        }
      }
      if (chunk.done) throw new RemoteFault("upstream_protocol_error");
    }
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => undefined); }
}
