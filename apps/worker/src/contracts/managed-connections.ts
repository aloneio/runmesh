import { isCapabilityIdentifier } from "./capabilities.js";
import { catalogObject } from "./catalog-json.js";
import { publicMcpEndpoint } from "./remote-values.js";

const failureCodes = ["invalid_request", "denied", "conflict", "invalid_callback", "provider_unsupported", "unavailable", "reauthorization_required"] as const;

export type ManagedConnectionResult =
  | { readonly state: "started"; readonly authorization_url: string; readonly profile_id: string }
  | { readonly state: "linked" | "revoked"; readonly profile_id: string }
  | { readonly state: "failed"; readonly code: typeof failureCodes[number]; readonly operation_state: "not_started" | "unknown" };

/** Shared pure URL rule for protocol I/O and public authorization redirects. */
export function publicOAuthUrl(value: unknown, selfOrigin?: string): string | undefined {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(value)) return undefined;
  try {
    const url = new URL(value), base = new URL(value); base.search = "";
    return url.hash || url.origin === selfOrigin || publicMcpEndpoint(base.href) === undefined ? undefined : url.href;
  } catch { return undefined; }
}

/** Project only public receipt fields, without forwarding internal credential fields. */
export function parseManagedConnectionResult(raw: unknown, selfOrigin?: string): ManagedConnectionResult | undefined {
  const value = catalogObject(raw);
  if (!value) return undefined;
  if (value.state === "failed") {
    const code = failureCodes.find(code => code === value.code);
    if (code === undefined || (value.operation_state !== "not_started" && value.operation_state !== "unknown")) return undefined;
    return { state: "failed", code, operation_state: value.operation_state };
  }
  if (!isCapabilityIdentifier(value.profile_id)) return undefined;
  if (value.state === "started") {
    const authorization_url = publicOAuthUrl(value.authorization_url, selfOrigin);
    return authorization_url === undefined ? undefined : { state: "started", profile_id: value.profile_id, authorization_url };
  }
  return value.state === "linked" || value.state === "revoked" ? { state: value.state, profile_id: value.profile_id } : undefined;
}

export interface ManagedConnections {
  connectionOAuth(sessionHash: string, action: "begin" | "complete" | "revoke", input: unknown, requestOrigin?: string): Promise<ManagedConnectionResult>;
}
export function connectionClientMetadata(origin: string) {
  return { client_name: "Runmesh", client_uri: origin, redirect_uris: [origin + "/admin/central/connections/callback"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
}
