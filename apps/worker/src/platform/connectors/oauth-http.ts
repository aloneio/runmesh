import { OAUTH_LIMITS, OAuthFault, type OAuthPolicy, type OAuthTransport } from "../../contracts/oauth.js";
import { catalogJson, catalogObject } from "../../contracts/catalog-json.js";
import { publicMcpEndpoint } from "../../contracts/remote-values.js";

/** OAuth HTTP, not a second MCP protocol stack. Metadata cannot add endpoints,
 * redirects, scopes or client secrets to the administrator's reviewed pins. */
export function createOAuthTransport(send: typeof fetch = fetch): OAuthTransport {
  async function request(url: string, body: URLSearchParams | undefined, signal: AbortSignal, beforeSend: () => Promise<void>): Promise<unknown> {
    if (publicMcpEndpoint(url) !== url || (body && body.toString().length > OAUTH_LIMITS.body_bytes)) throw new OAuthFault("invalid_request");
    await beforeSend();
    if (signal.aborted) throw new OAuthFault("unavailable");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelled = () => { void reader?.cancel().catch(() => undefined); };
    try {
      const response = await send(url, { method: body === undefined ? "GET" : "POST", redirect: "manual", credentials: "omit", cache: "no-store", signal,
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
        ...(body === undefined ? {} : { body: body.toString() }) });
      const length = response.headers.get("content-length");
      if (signal.aborted || response.status !== 200 || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")
        || response.body === null || (length !== null && (!/^\d+$/u.test(length) || Number(length) > OAUTH_LIMITS.response_bytes))) {
        void response.body?.cancel().catch(() => undefined); throw new OAuthFault("provider_unsupported");
      }
      reader = response.body.getReader(); signal.addEventListener("abort", cancelled, { once: true });
      const chunks: Uint8Array[] = []; let size = 0, fragments = 0;
      while (true) {
        const piece = await reader.read();
        if (signal.aborted) throw new OAuthFault("unavailable");
        if (piece.done) break;
        if (++fragments > 256 || (size += piece.value.length) > OAUTH_LIMITS.response_bytes) throw new OAuthFault("provider_unsupported");
        chunks.push(piece.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (catalogJson(parsed, OAUTH_LIMITS.response_bytes) === undefined) throw new OAuthFault("provider_unsupported");
      return parsed;
    } catch (error) { throw error instanceof OAuthFault ? error : new OAuthFault("unavailable"); }
    finally { signal.removeEventListener("abort", cancelled); if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); } }
  }
  const form = (p: OAuthPolicy) => new URLSearchParams({ client_id: p.oauth_client_id, resource: p.resource });
  return {
    async verify(p, signal, beforeSend) {
      const m = catalogObject(await request(p.metadata_endpoint, undefined, signal, beforeSend));
      const includes = (key: string, item: string) => Array.isArray(m?.[key]) && (m![key] as unknown[]).includes(item);
      if (m?.issuer !== p.issuer || m.authorization_endpoint !== p.authorization_endpoint || m.token_endpoint !== p.token_endpoint
        || !includes("code_challenge_methods_supported", "S256") || !includes("response_types_supported", "code")
        || !includes("grant_types_supported", "authorization_code") || !includes("token_endpoint_auth_methods_supported", "none")
        || m.authorization_response_iss_parameter_supported !== true
        || (m.scopes_supported !== undefined && p.scopes.some(s => !includes("scopes_supported", s)))) throw new OAuthFault("provider_unsupported");
    },
    async exchange(p, redirect, code, verifier, signal, beforeSend) {
      const body = form(p); body.set("grant_type", "authorization_code"); body.set("redirect_uri", redirect);
      body.set("code", code); body.set("code_verifier", verifier);
      return request(p.token_endpoint, body, signal, beforeSend);
    },
    async refresh(p, token, signal, beforeSend) {
      const body = form(p); body.set("grant_type", "refresh_token"); body.set("refresh_token", token);
      return request(p.token_endpoint, body, signal, beforeSend);
    },
  };
}
