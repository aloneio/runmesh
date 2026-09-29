import type { CredentialInput } from "./connectors.js";

export type OAuthCode = "invalid_request" | "denied" | "conflict" | "invalid_callback"
  | "provider_unsupported" | "reauthorization_required" | "configuration_required" | "unavailable";
export class OAuthFault extends Error { constructor(public readonly code: OAuthCode) { super(code); this.name = "OAuthFault"; } }

export interface CredentialLease { readonly credential: CredentialInput; readonly current: () => boolean }
