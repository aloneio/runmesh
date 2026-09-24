/** Profiles are owned explicitly. A client label is not a natural-person identity. */
export interface ConnectionProfile {
  readonly schema_version: 1;
  readonly profile_id: string;
  readonly connector_id: string;
  readonly owner: { readonly kind: "instance_admin" };
  readonly revision: number;
  readonly enabled: boolean;
  readonly credential: SecretReference | null;
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
