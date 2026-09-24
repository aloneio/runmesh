import { OAUTH_CODES, OAUTH_LIMITS, type OAuthAdministration, type OAuthMetadata } from "../contracts/oauth.js";
import { parseOAuthCallback, parseOAuthPolicies, parseOAuthSelection, oauthState } from "../contracts/oauth-values.js";
import { catalogDigest, catalogJson, catalogKeys, catalogObject, catalogRevision } from "../contracts/catalog-json.js";
import { isCapabilityIdentifier } from "../contracts/capabilities.js";
import type { WorkerEnv } from "../platform/env.js";
import { admitCentralAdmin, cancelCentralBody, centralFailure, centralHeaders } from "./central-boundary.js";
import { oauthLanding } from "./oauth-landing.js";

function metadata(value: unknown): OAuthMetadata | undefined {
  const p = catalogObject(value);
  if (p === undefined || !catalogKeys(p, ["schema_version", "link_id", "profile_id", "client_id", "secret_version", "revision", "state", "expires_at_ms"])
    || p.schema_version !== 1 || !catalogDigest(p.link_id) || !isCapabilityIdentifier(p.profile_id) || !isCapabilityIdentifier(p.client_id)
    || !catalogRevision(p.secret_version) || !catalogRevision(p.revision) || !catalogRevision(p.expires_at_ms, true)
    || !["pending", "exchanging", "ready", "refreshing", "reauthorize", "revoked"].includes(p.state as string)) return undefined;
  return p as unknown as OAuthMetadata;
}

export async function handleCentralOAuth(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const endpoint = url.pathname.slice("/admin/central/oauth/".length);
  if (env.CAPABILITIES === undefined) { cancelCentralBody(request); return centralFailure("central_disabled", 404); }
  if (endpoint === "callback") {
    if (request.method !== "GET" || url.href.length > 8192 || parseOAuthPolicies(env.CENTRAL_OAUTH_POLICIES) === undefined) {
      cancelCentralBody(request); return centralFailure("oauth_invalid_callback", 400);
    }
    return oauthLanding();
  }
  if (url.search || !["begin", "complete", "inspect", "revoke"].includes(endpoint) || request.method !== "POST") {
    cancelCentralBody(request); return centralFailure("central_not_found", 404);
  }
  const policies = parseOAuthPolicies(env.CENTRAL_OAUTH_POLICIES);
  if (["begin", "complete"].includes(endpoint) && policies === undefined) { cancelCentralBody(request); return centralFailure("central_disabled", 404); }
  const admission = await admitCentralAdmin(request, env, OAUTH_LIMITS.body_bytes);
  if (admission instanceof Response) return admission;
  const input = endpoint === "complete" ? parseOAuthCallback(admission.body) : parseOAuthSelection(admission.body);
  if (input === undefined) return centralFailure("oauth_invalid_request", 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unconfirmed = () => centralFailure("oauth_result_unconfirmed", 503, "unknown");
  try {
    const owner = env.CAPABILITIES.get(env.CAPABILITIES.idFromName("central")) as unknown as OAuthAdministration;
    const action = endpoint === "begin" ? owner.beginOAuth.bind(owner) : endpoint === "complete" ? owner.completeOAuth.bind(owner)
      : endpoint === "inspect" ? owner.inspectOAuth.bind(owner) : owner.revokeOAuth.bind(owner);
    const raw = await Promise.race([action(admission.session_hash, input), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 6000); })]);
    if (catalogJson(raw, OAUTH_LIMITS.body_bytes) === undefined) return unconfirmed();
    const result = catalogObject(raw);
    if (result === undefined) return unconfirmed();
    if (result.state === "failed") {
      if (!OAUTH_CODES.includes(result.code as never) || !["not_started", "unknown"].includes(result.operation_state as string)) return unconfirmed();
      return centralFailure(`oauth_${result.code}`, result.code === "denied" ? 403 : result.code === "conflict" ? 409
        : ["invalid_callback", "invalid_request"].includes(result.code as string) ? 400 : result.code === "capacity" ? 429 : 503, result.operation_state as string);
    }
    const expected = { begin: "started", complete: "linked", inspect: "found", revoke: "revoked" }[endpoint];
    const link = metadata(result.link);
    if (result.state !== expected || link === undefined) return unconfirmed();
    if ("principal" in input && (link.profile_id !== input.profile_id || link.client_id !== input.principal.client_id
      || (endpoint !== "inspect" && (link.secret_version !== input.principal.secret_version || link.revision !== input.expected_revision + 1)))) return unconfirmed();
    if ((endpoint === "begin" && link.state !== "pending") || (endpoint === "complete" && link.state !== "ready") || (endpoint === "revoke" && link.state !== "revoked")) return unconfirmed();
    if (endpoint === "begin") {
      const policy = policies?.find(p => p.profile_id === link.profile_id);
      if (policy === undefined || typeof result.authorization_url !== "string" || result.authorization_url.length > 8192) return unconfirmed();
      const target = new URL(result.authorization_url), params = target.searchParams;
      if (target.origin + target.pathname !== policy.authorization_endpoint || target.hash || target.username || target.password
        || [...params.keys()].length !== 8 || params.get("client_id") !== policy.oauth_client_id || params.get("response_type") !== "code"
        || params.get("redirect_uri") !== env.RUNMESH_PUBLIC_ORIGIN + "/admin/central/oauth/callback" || params.get("resource") !== policy.resource
        || params.get("scope") !== policy.scopes.join(" ") || params.get("code_challenge_method") !== "S256"
        || !oauthState(params.get("code_challenge")) || !oauthState(params.get("state"))) return unconfirmed();
      return Response.json({ state: "started", authorization_url: target.href, link }, { headers: centralHeaders });
    }
    return Response.json({ state: expected, link }, { headers: centralHeaders });
  } catch { return unconfirmed(); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
