/** Profiles are owned explicitly. A client label is not a natural-person identity. */
export interface ConnectionProfile {
  readonly schema_version: 1;
  readonly profile_id: string;
  readonly connector_id: string;
  readonly display_name?: string;
  /** Immutable credential-free HTTPS destination; outbound SSRF admission is separate. */
  readonly endpoint: string;
  readonly owner: { readonly kind: "instance_admin" };
  readonly revision: number;
  readonly enabled: boolean;
  readonly credential: SecretReference | null;
  /** Present only for connections explicitly created from the control panel. */
  readonly authentication?: "none" | "oauth";
}

export interface SecretReference {
  readonly secret_id: string;
  readonly secret_version: number;
}

/** Implementations must enforce ownership and version; no inbound/Runner secret reuse.
 * This is a port only. No plaintext storage or placeholder credentials are supplied. */
export interface SecretVault {
  withCredential<T>(profile: ConnectionProfile, signal: AbortSignal,
    consume: (headers: Readonly<Record<string, string>>) => Promise<T>): Promise<T>;
}

export const CONNECTOR_LIMITS = Object.freeze({ profiles: 1_000, token_bytes: 4_096, envelope_bytes: 8_192,
  request_bytes: 16_384, keyring_bytes: 4_096, keys: 4, operation_ms: 5_000 });

export interface CredentialInput { readonly kind: "bearer"; readonly token: string }
export interface CredentialEnvelope {
  readonly schema_version: 1;
  readonly key_id: string;
  readonly iv: string;
  readonly ciphertext: string;
}
export interface ProfileRecord { readonly profile: ConnectionProfile; readonly envelope: CredentialEnvelope | null }
export type ProfileCommand =
  | { readonly action: "connect"; readonly profile_id: string; readonly connector_id: string; readonly display_name?: string; readonly endpoint: string; readonly authentication: "none" | "oauth" }
  | { readonly action: "create_oauth"; readonly profile_id: string; readonly connector_id: string; readonly display_name?: string; readonly endpoint: string }
  | { readonly action: "create"; readonly profile_id: string; readonly connector_id: string; readonly display_name?: string; readonly endpoint: string; readonly credential: CredentialInput }
  | { readonly action: "rotate"; readonly profile_id: string; readonly expected_revision: number; readonly credential: CredentialInput }
  | { readonly action: "enable" | "disable" | "rekey"; readonly profile_id: string; readonly expected_revision: number };
export type ProfileResult =
  | { readonly state: "written"; readonly profile: ConnectionProfile }
  | { readonly state: "conflict"; readonly current_revision: number }
  | { readonly state: "invalid" | "missing" | "capacity" | "denied" | "unavailable" | "unknown" };

/** Storage operations stay synchronous inside their original DO transaction. */
export interface ProfileRepository {
  read(profileId: string): ProfileRecord | undefined;
  replace(record: ProfileRecord, expectedRevision: number): ProfileResult;
}
export interface CredentialCipher {
  seal(profile: ConnectionProfile, credential: CredentialInput): Promise<CredentialEnvelope>;
  open(profile: ConnectionProfile, envelope: CredentialEnvelope): Promise<CredentialInput>;
}
export type AdminDecision = "allowed" | "denied" | "unavailable";
export interface ProfileServicePorts {
  readonly repository: ProfileRepository;
  readonly cipher: CredentialCipher;
  readonly authorize: (signal: AbortSignal) => Promise<AdminDecision>;
}
export interface CentralAdministration {
  getProfile(sessionHash: string, profileId: string): Promise<{ readonly state: "found"; readonly profile: ConnectionProfile } | { readonly state: "missing" | "denied" | "unavailable" }>;
  mutateProfile(sessionHash: string, command: unknown): Promise<ProfileResult>;
}
