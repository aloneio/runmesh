export type ManagedConnectionResult =
  | { readonly state: "started"; readonly authorization_url: string; readonly profile_id: string }
  | { readonly state: "linked" | "revoked"; readonly profile_id: string }
  | { readonly state: "failed"; readonly code: "invalid_request" | "denied" | "conflict" | "invalid_callback" | "provider_unsupported" | "unavailable" | "reauthorization_required"; readonly operation_state: "not_started" | "unknown" };
export interface ManagedConnections {
  connectionOAuth(sessionHash: string, action: "begin" | "complete" | "revoke", input: unknown, requestOrigin?: string): Promise<ManagedConnectionResult>;
}
export function connectionClientMetadata(origin: string) {
  return { client_name: "Runmesh", client_uri: origin, redirect_uris: [origin + "/admin/central/connections/callback"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
}
