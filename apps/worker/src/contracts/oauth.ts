import type { CredentialEnvelope, CredentialInput } from "./connectors.js";

export type OAuthCode = "invalid_request" | "denied" | "conflict" | "invalid_callback"
  | "provider_unsupported" | "reauthorization_required" | "unavailable";
export class OAuthFault extends Error { constructor(public readonly code: OAuthCode) { super(code); this.name = "OAuthFault"; } }

export interface OAuthCipher {
  seal(context: string, value: unknown): Promise<CredentialEnvelope>;
  open(context: string, envelope: CredentialEnvelope): Promise<unknown>;
}
export interface CredentialLease { readonly credential: CredentialInput; readonly current: () => boolean }
