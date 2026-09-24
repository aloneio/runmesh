/** Versioned identity vocabulary. Identity is not a central capability grant. */
export const NATIVE_SCOPES = ["coding:read", "coding:write", "coding:exec"] as const;
export type CodingScope = (typeof NATIVE_SCOPES)[number];

export interface ClientIdentity {
  readonly schema_version: 2;
  readonly client_id: string;
  readonly label: string;
  readonly secret_version: number;
  readonly native_scopes: readonly CodingScope[];
}

export interface CapturedIdentity {
  readonly client_id: string;
  readonly secret_version: number;
}

export type IdentityDecision =
  | { readonly state: "allowed"; readonly identity: ClientIdentity }
  | { readonly state: "denied" | "unavailable" | "malformed" };

/** A fresh observation, not a cached permission or a natural-person account. */
export interface IdentityReader {
  revalidate(principal: CapturedIdentity, signal: AbortSignal): Promise<IdentityDecision>;
}

export function parseNativeScopes(value: unknown, allowEmpty = false): CodingScope[] | undefined {
  if (!Array.isArray(value) || value.length > NATIVE_SCOPES.length || (!allowEmpty && value.length === 0)
    || new Set(value).size !== value.length || value.some(scope => !NATIVE_SCOPES.includes(scope as CodingScope))) return undefined;
  return [...value] as CodingScope[];
}

/** Unknown versions fail closed; an empty legacy array remains malformed. */
export function parseStoredNativeScopes(value: string): CodingScope[] | undefined {
  if (value.length > 1024) return undefined;
  try {
    const decoded: unknown = JSON.parse(value);
    if (Array.isArray(decoded)) return parseNativeScopes(decoded);
    if (typeof decoded !== "object" || decoded === null) return undefined;
    const record = decoded as Record<string, unknown>;
    if (record.schema_version !== 2 || Object.keys(record).some(key => key !== "schema_version" && key !== "native_scopes")) return undefined;
    return parseNativeScopes(record.native_scopes, true);
  } catch { return undefined; }
}

/** Whitelist projection; secrets, Runner selection and central ACLs never enter it. */
export function parseClientIdentity(value: unknown): ClientIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 2 || typeof record.client_id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record.client_id)
    || typeof record.label !== "string" || record.label.trim().length === 0 || record.label.length > 256
    || !Number.isSafeInteger(record.secret_version) || (record.secret_version as number) < 1) return undefined;
  const scopes = parseNativeScopes(record.native_scopes, true);
  if (scopes === undefined) return undefined;
  return { schema_version: 2, client_id: record.client_id, label: record.label,
    secret_version: record.secret_version as number, native_scopes: scopes };
}
