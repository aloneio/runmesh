import type { AdminDecision, ConnectionProfile } from "./connectors.js";
import { SECRET_STORAGE_LIMITS, type EncryptedSecret, type SecretStorage } from "./secret-storage.js";

export const MANAGED_OAUTH_DISCOVERY_BYTES = 32_768;

/** Three encrypted values, discovery metadata and bounded record fields. */
export const MANAGED_OAUTH_RECORD_BYTES = 3 * (SECRET_STORAGE_LIMITS.ciphertext_bytes + 256) + MANAGED_OAUTH_DISCOVERY_BYTES + 4096;

/** Opaque provider metadata is interpreted only by the protocol adapter.
 * Neither lifecycle rules nor persistence depend on the SDK's versioned types. */
export type ManagedOAuthDocument = Readonly<Record<string, unknown>>;
export interface ManagedOAuthTokens {
  readonly access_token: string;
  readonly token_type: string;
  readonly refresh_token?: string | undefined;
  readonly expires_in?: number | undefined;
  readonly issuer?: string | undefined;
}
export interface ManagedOAuthRecord {
  profile_id: string; profile_revision: number; revision: number;
  state: "starting" | "pending" | "exchanging" | "ready" | "refreshing" | "revoked";
  session_hash: string; state_hash: string; origin: string; expires_at: number; token_expires_at: number;
  discovery?: ManagedOAuthDocument | undefined;
  client?: EncryptedSecret | undefined; verifier?: EncryptedSecret | undefined; tokens?: EncryptedSecret | undefined;
}
export interface ManagedOAuthRepository {
  read(id: string): ManagedOAuthRecord | undefined;
  find(stateHash: string): ManagedOAuthRecord | undefined;
  replace(value: ManagedOAuthRecord, revision: number): boolean;
}
interface ProtocolOperation {
  readonly endpoint: string; readonly origin: string; readonly signal: AbortSignal;
  readonly authorize: () => Promise<void>;
}
interface TokenOperation extends ProtocolOperation {
  /** Claim the one-use credential synchronously after admission and immediately
   * before dispatch. Preparation failures leave its persisted state unchanged. */
  readonly beforeTokenRequest: () => void;
}
export interface ManagedOAuthProtocol {
  begin(input: ProtocolOperation & { readonly state: string }): Promise<{
    readonly authorization_url: string; readonly discovery: ManagedOAuthDocument;
    readonly client: unknown; readonly verifier: string;
  }>;
  complete(input: TokenOperation & { readonly discovery: ManagedOAuthDocument; readonly client: unknown;
    readonly verifier: unknown; readonly code: string; readonly issuer?: string }): Promise<ManagedOAuthTokens>;
  refresh(input: TokenOperation & { readonly discovery: ManagedOAuthDocument; readonly client: unknown;
    readonly refresh_token: string; readonly issuer?: string }): Promise<ManagedOAuthTokens>;
}
export interface ManagedOAuthPorts {
  readonly repository: ManagedOAuthRepository; readonly cipher: SecretStorage; readonly protocol: ManagedOAuthProtocol;
  readonly profile: (id: string) => ConnectionProfile | undefined;
  readonly admin: (hash: string, signal: AbortSignal) => Promise<AdminDecision>;
  readonly origin: () => string | undefined; readonly hash: (value: string) => Promise<string>;
  readonly random: () => string; readonly now: () => number;
}
