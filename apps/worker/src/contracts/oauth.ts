import type { CapturedIdentity, IdentityDecision } from "./identity.js";
import type { AdminDecision, ConnectionProfile, CredentialEnvelope, CredentialInput } from "./connectors.js";

/** Explicit administrator-mediated delegation to one MCP credential generation.
 * A client ID is not a natural-person account and never implies shared consent. */
export const OAUTH_LIMITS = Object.freeze({ policies: 64, policy_bytes: 32_768, body_bytes: 16_384,
  response_bytes: 32_768, token_bytes: 2_048, flow_ttl_ms: 300_000, refresh_margin_ms: 30_000,
  links: 1_000, flows: 64, active: 4, expires_seconds: 86_400 });
export const OAUTH_CODES = Object.freeze(["disabled", "invalid_request", "denied", "missing", "conflict",
  "capacity", "invalid_callback", "provider_unsupported", "reauthorization_required", "unavailable", "unknown"] as const);
export type OAuthCode = (typeof OAUTH_CODES)[number];
export class OAuthFault extends Error { constructor(public readonly code: OAuthCode) { super(code); this.name = "OAuthFault"; } }

export interface OAuthPolicy {
  readonly profile_id: string;
  readonly resource: string;
  readonly issuer: string;
  readonly metadata_endpoint: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly oauth_client_id: string;
  readonly scopes: readonly string[];
}
export interface OAuthBinding extends CapturedIdentity {
  readonly profile_id: string;
  readonly endpoint: string;
  readonly policy_digest: string;
}
export type OAuthLinkState = "pending" | "exchanging" | "ready" | "refreshing" | "reauthorize" | "revoked";
export interface OAuthLink {
  readonly schema_version: 1;
  readonly link_id: string;
  readonly binding: OAuthBinding;
  readonly revision: number;
  readonly state: OAuthLinkState;
  readonly expires_at_ms: number;
  readonly envelope: CredentialEnvelope | null;
}
export interface OAuthFlow {
  readonly state_hash: string;
  readonly link_id: string;
  readonly revision: number;
  readonly session_hash: string;
  readonly expires_at_ms: number;
  readonly verifier: CredentialEnvelope;
}
export interface OAuthTokens {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_at_ms: number;
  readonly scopes: readonly string[];
}
export interface OAuthSelection { readonly profile_id: string; readonly principal: CapturedIdentity; readonly expected_revision: number }
export interface OAuthCallback { readonly state: string; readonly iss: string; readonly code?: string; readonly error?: string }
export type OAuthMetadata = Omit<OAuthLink, "envelope" | "binding"> & { readonly profile_id: string; readonly client_id: string; readonly secret_version: number };
export type OAuthResult = { readonly state: "started"; readonly authorization_url: string; readonly link: OAuthMetadata }
  | { readonly state: "linked" | "found" | "revoked"; readonly link: OAuthMetadata }
  | { readonly state: "failed"; readonly code: OAuthCode; readonly operation_state: "not_started" | "unknown" };

/** Synchronous storage owns the claim before any one-use token request. */
export interface OAuthRepository {
  read(linkId: string): OAuthLink | undefined;
  flow(stateHash: string): OAuthFlow | undefined;
  begin(link: OAuthLink, flow: OAuthFlow, expectedRevision: number, now: number): void;
  consume(stateHash: string, sessionHash: string, now: number): OAuthLink;
  transition(link: OAuthLink, expectedRevision: number, expectedState: OAuthLinkState): void;
}
export interface OAuthCipher {
  seal(context: string, value: unknown): Promise<CredentialEnvelope>;
  open(context: string, envelope: CredentialEnvelope): Promise<unknown>;
}
export interface OAuthTransport {
  verify(policy: OAuthPolicy, signal: AbortSignal, beforeSend: () => Promise<void>): Promise<void>;
  exchange(policy: OAuthPolicy, redirect: string, code: string, verifier: string, signal: AbortSignal, beforeSend: () => Promise<void>): Promise<unknown>;
  refresh(policy: OAuthPolicy, token: string, signal: AbortSignal, beforeSend: () => Promise<void>): Promise<unknown>;
}
export interface OAuthPorts {
  readonly repository: OAuthRepository;
  readonly cipher: OAuthCipher;
  readonly transport: OAuthTransport;
  readonly policy: (profileId: string) => OAuthPolicy | undefined;
  readonly redirect: () => string | undefined;
  readonly profile: (profileId: string) => ConnectionProfile | undefined;
  readonly admin: (sessionHash: string, signal: AbortSignal) => Promise<AdminDecision>;
  readonly identity: (principal: CapturedIdentity, signal: AbortSignal) => Promise<IdentityDecision>;
  readonly hash: (text: string) => Promise<string>;
  readonly random: () => string;
  readonly challenge: (verifier: string) => Promise<string>;
  readonly now: () => number;
}
export interface CredentialLease { readonly credential: CredentialInput; readonly current: () => boolean }
export interface OAuthAdministration {
  beginOAuth(sessionHash: string, input: unknown): Promise<OAuthResult>;
  completeOAuth(sessionHash: string, input: unknown): Promise<OAuthResult>;
  inspectOAuth(sessionHash: string, input: unknown): Promise<OAuthResult>;
  revokeOAuth(sessionHash: string, input: unknown): Promise<OAuthResult>;
}
