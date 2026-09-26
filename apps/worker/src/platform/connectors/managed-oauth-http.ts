import type { FetchLike, OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { publicMcpEndpoint } from "../../contracts/remote-values.js";

export function publicOAuthUrl(value: unknown, selfOrigin?: string): string | undefined {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(value)) return undefined;
  try {
    const url = new URL(value), base = new URL(value); base.search = "";
    return url.hash || url.origin === selfOrigin || publicMcpEndpoint(base.href) === undefined ? undefined : url.href;
  } catch { return undefined; }
}
export function validDiscovery(value: OAuthDiscoveryState, selfOrigin: string) {
  const metadata = value.authorizationServerMetadata;
  return JSON.stringify(value).length <= 32_768 && metadata !== undefined
    && [value.authorizationServerUrl, metadata.issuer, metadata.authorization_endpoint, metadata.token_endpoint].every(v => publicOAuthUrl(v, selfOrigin) !== undefined)
    && (metadata.registration_endpoint === undefined || publicOAuthUrl(metadata.registration_endpoint, selfOrigin) !== undefined);
}
/** Public HTTPS only, no redirects/cookies, bounded bodies and no token replay.
 * Token and registration writes are pinned to the discovered metadata. */
export function managedOAuthFetch(ports: { signal: AbortSignal; authorize: () => Promise<void>; discovery: () => OAuthDiscoveryState | undefined;
  origin: string; send?: FetchLike; phase: "begin" | "complete" | "refresh" }): FetchLike {
  let requests = 0, posts = 0, total = 0;
  return async (input, init) => {
    const url = publicOAuthUrl(String(input), ports.origin), method = init?.method ?? "GET";
    if (url === undefined || ++requests > 12 || !["GET", "POST"].includes(method)) throw new TypeError("oauth_destination_denied");
    const metadata = ports.discovery()?.authorizationServerMetadata;
    if (method === "POST") {
      const expected = ports.phase === "begin" ? metadata?.registration_endpoint : metadata?.token_endpoint;
      if (!expected || url !== publicOAuthUrl(expected, ports.origin) || ++posts > 1) throw new TypeError("oauth_write_denied");
    }
    const headers = new Headers(init?.headers);
    if (method === "GET" && headers.has("authorization")) throw new TypeError("oauth_credential_denied");
    headers.delete("cookie");
    const body = init?.body;
    if (body !== undefined && body !== null && (!(typeof body === "string" || body instanceof URLSearchParams) || new TextEncoder().encode(String(body)).length > 16_384)) throw new TypeError("oauth_request_invalid");
    await ports.authorize(); ports.signal.throwIfAborted();
    const response = await (ports.send ?? fetch)(url, { method, headers, ...(body === undefined ? {} : { body }), signal: ports.signal, credentials: "omit", redirect: "manual", cache: "no-store" });
    if (response.status >= 300 && response.status < 400) { void response.body?.cancel(); throw new TypeError("oauth_redirect_denied"); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0, count = 0;
    const abort = () => { void reader?.cancel().catch(() => undefined); }; ports.signal.addEventListener("abort", abort, { once: true });
    try {
      if (reader) for (;;) {
        ports.signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
        size += next.value.length; total += next.value.length;
        if (++count > 1024 || size > 65_536 || total > 262_144) throw new TypeError("oauth_response_too_large");
        chunks.push(next.value);
      }
      await ports.authorize(); ports.signal.throwIfAborted();
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return new Response(size ? bytes : null, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
    } finally { ports.signal.removeEventListener("abort", abort); void reader?.cancel().catch(() => undefined); }
  };
}
