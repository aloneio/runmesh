import { OAUTH_LIMITS, type OAuthCallback, type OAuthLink, type OAuthMetadata, type OAuthPolicy, type OAuthSelection, type OAuthTokens } from "./oauth.js";
import { isCapabilityIdentifier } from "./capabilities.js";
import { catalogDigest, catalogJson, catalogKeys, catalogObject, catalogRevision } from "./catalog-json.js";
import { parseEnvelope } from "./connector-values.js";
import { publicMcpEndpoint } from "./remote-values.js";

const token = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= OAUTH_LIMITS.token_bytes && /^[A-Za-z0-9._~+\/-]+=*$/u.test(v);
export const oauthState = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/u.test(v);
const scopes = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 16 && new Set(v).size === v.length
  && v.every(s => typeof s === "string" && /^[\x21\x23-\x5b\x5d-\x7e]{1,64}$/u.test(s));
export const oauthLinkKey = (profileId: string, clientId: string): string => JSON.stringify(["runmesh-oauth-link-v1", profileId, clientId]);
export const oauthTokenContext = (link: OAuthLink): string => JSON.stringify(["tokens", link.link_id, link.binding, link.revision]);
export const oauthFlowContext = (hash: string, session: string): string => JSON.stringify(["pkce", hash, session]);

/** Explicit pre-registration and endpoint pins. No dynamic registration or
 * arbitrary WWW-Authenticate URLs. Metadata must later confirm every pin. */
export function parseOAuthPolicies(raw: unknown): OAuthPolicy[] | undefined {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > OAUTH_LIMITS.policy_bytes) return undefined;
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0 || list.length > OAUTH_LIMITS.policies) return undefined;
    const seen = new Set<string>(), result: OAuthPolicy[] = [];
    for (const value of list) {
      const p = catalogObject(value);
      if (p === undefined || !catalogKeys(p, ["profile_id", "resource", "issuer", "metadata_endpoint", "authorization_endpoint", "token_endpoint", "oauth_client_id", "scopes"])
        || !isCapabilityIdentifier(p.profile_id) || seen.has(p.profile_id) || !scopes(p.scopes)
        || typeof p.oauth_client_id !== "string" || !/^[\x21-\x7e]{1,256}$/u.test(p.oauth_client_id)) return undefined;
      if ([p.resource, p.metadata_endpoint, p.authorization_endpoint, p.token_endpoint].some(v => typeof v !== "string" || publicMcpEndpoint(v) !== v)
        || typeof p.issuer !== "string" || publicMcpEndpoint(p.issuer) === undefined) return undefined;
      const issuer = new URL(p.issuer as string);
      const path = issuer.pathname.replace(/\/$/u, "");
      if (p.metadata_endpoint !== issuer.origin + "/.well-known/oauth-authorization-server" + path
        || new URL(p.authorization_endpoint as string).origin !== issuer.origin || new URL(p.token_endpoint as string).origin !== issuer.origin) return undefined;
      seen.add(p.profile_id); result.push({ ...p, scopes: [...p.scopes].sort() } as unknown as OAuthPolicy);
    }
    return result;
  } catch { return undefined; }
}
export function parseOAuthSelection(value: unknown): OAuthSelection | undefined {
  const p = catalogObject(value), principal = catalogObject(p?.principal);
  if (p === undefined || !catalogKeys(p, ["profile_id", "principal", "expected_revision"]) || !isCapabilityIdentifier(p.profile_id)
    || !catalogRevision(p.expected_revision, true) || principal === undefined || !catalogKeys(principal, ["client_id", "secret_version"])
    || !isCapabilityIdentifier(principal.client_id) || !catalogRevision(principal.secret_version)) return undefined;
  return { profile_id: p.profile_id, principal: { client_id: principal.client_id, secret_version: principal.secret_version }, expected_revision: p.expected_revision };
}
export function parseOAuthCallback(value: unknown): OAuthCallback | undefined {
  const p = catalogObject(value);
  if (p === undefined || !catalogKeys(p, ["state", "iss", "code", "error"]) || !oauthState(p.state) || typeof p.iss !== "string" || p.iss.length > 2048
    || (p.code === undefined) === (p.error === undefined)) return undefined;
  if (p.code !== undefined && (typeof p.code !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(p.code))) return undefined;
  if (p.error !== undefined && (typeof p.error !== "string" || !/^[a-z_]{1,64}$/u.test(p.error))) return undefined;
  return { state: p.state, iss: p.iss, ...(p.code === undefined ? { error: p.error as string } : { code: p.code as string }) };
}
export function parseOAuthLink(value: unknown): OAuthLink | undefined {
  const p = catalogObject(value), b = catalogObject(p?.binding);
  if (p === undefined || b === undefined || !catalogKeys(p, ["schema_version", "link_id", "binding", "revision", "state", "expires_at_ms", "envelope"])
    || !catalogKeys(b, ["profile_id", "client_id", "secret_version", "endpoint", "policy_digest"])
    || p.schema_version !== 1 || !catalogDigest(p.link_id) || !isCapabilityIdentifier(b.profile_id) || !isCapabilityIdentifier(b.client_id)
    || !catalogRevision(b.secret_version) || !catalogDigest(b.policy_digest) || typeof b.endpoint !== "string" || publicMcpEndpoint(b.endpoint) !== b.endpoint
    || !catalogRevision(p.revision) || !catalogRevision(p.expires_at_ms, true)
    || !["pending", "exchanging", "ready", "refreshing", "reauthorize", "revoked"].includes(p.state as string)
    || (p.envelope !== null && parseEnvelope(p.envelope) === undefined)
    || (["ready", "refreshing"].includes(p.state as string) ? p.envelope === null : p.envelope !== null)) return undefined;
  return JSON.parse(JSON.stringify(p)) as OAuthLink;
}
export function oauthMetadata(link: OAuthLink): OAuthMetadata {
  return { schema_version: 1, link_id: link.link_id, profile_id: link.binding.profile_id, client_id: link.binding.client_id,
    secret_version: link.binding.secret_version, revision: link.revision, state: link.state, expires_at_ms: link.expires_at_ms };
}
export function parseOAuthTokenResponse(value: unknown, requested: readonly string[], now: number, oldRefresh?: string): OAuthTokens | undefined {
  const p = catalogObject(value);
  if (p === undefined || !token(p.access_token) || typeof p.token_type !== "string" || p.token_type.toLowerCase() !== "bearer"
    || !Number.isSafeInteger(p.expires_in) || (p.expires_in as number) < 60 || (p.expires_in as number) > OAUTH_LIMITS.expires_seconds
    || (p.refresh_token !== undefined && (!token(p.refresh_token) || p.refresh_token === oldRefresh))) return undefined;
  const granted = p.scope === undefined ? [...requested] : typeof p.scope === "string" ? p.scope.split(" ") : undefined;
  if (!scopes(granted) || granted.some(s => !requested.includes(s)) || !Number.isSafeInteger(now) || now < 0) return undefined;
  return { access_token: p.access_token, ...(p.refresh_token === undefined ? {} : { refresh_token: p.refresh_token as string }),
    expires_at_ms: now + (p.expires_in as number) * 1000, scopes: [...granted].sort() };
}
export function parseStoredOAuthTokens(value: unknown): OAuthTokens | undefined {
  const p = catalogObject(value);
  if (p === undefined || !catalogKeys(p, ["access_token", "refresh_token", "expires_at_ms", "scopes"])
    || !token(p.access_token) || (p.refresh_token !== undefined && !token(p.refresh_token)) || !catalogRevision(p.expires_at_ms) || !scopes(p.scopes)) return undefined;
  const encoded = catalogJson(p, 8192);
  return encoded === undefined ? undefined : JSON.parse(encoded) as OAuthTokens;
}
