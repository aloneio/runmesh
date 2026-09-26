import { CONNECTOR_LIMITS, type ConnectionProfile, type CredentialEnvelope, type CredentialInput, type ProfileCommand } from "./connectors.js";
import { isCapabilityIdentifier } from "./capabilities.js";

const object = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const displayName = (item: Record<string, unknown>): boolean => item.display_name === undefined || (typeof item.display_name === "string" && item.display_name.trim().length > 0 && item.display_name.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(item.display_name));
const namedKeys = (item: Record<string, unknown>, keys: readonly string[]): readonly string[] => [...keys, ...["display_name", "authentication"].filter(key => Object.hasOwn(item, key) && !keys.includes(key))];
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) < Number.MAX_SAFE_INTEGER;

/** Syntax validation only; outbound DNS and SSRF admission belongs to the HTTP adapter. */
export function profileEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return undefined;
    return url.href.length <= 2_048 ? url.href : undefined;
  } catch { return undefined; }
}

export function parseCredential(value: unknown): CredentialInput | undefined {
  const item = object(value);
  if (item === undefined || !exact(item, ["kind", "token"]) || item.kind !== "bearer" || typeof item.token !== "string"
    || item.token.length < 1 || item.token.length > CONNECTOR_LIMITS.token_bytes || !/^[A-Za-z0-9._~+\/-]+=*$/u.test(item.token)) return undefined;
  return { kind: "bearer", token: item.token };
}

export function parseProfile(value: unknown): ConnectionProfile | undefined {
  const item = object(value), owner = object(item?.owner), credential = object(item?.credential);
  if (item?.authentication !== undefined && (!["none", "oauth"].includes(item.authentication as string) || item.credential !== null)) return undefined;
  if (item === undefined || !displayName(item) || !exact(item, namedKeys(item, ["schema_version", "profile_id", "connector_id", "endpoint", "owner", "revision", "enabled", "credential"]))
    || item.schema_version !== 1 || !isCapabilityIdentifier(item.profile_id) || !isCapabilityIdentifier(item.connector_id)
    || !revision(item.revision) || typeof item.enabled !== "boolean" || owner === undefined || !exact(owner, ["kind"]) || owner.kind !== "instance_admin"
    || (item.credential !== null && (credential === undefined || !exact(credential, ["secret_id", "secret_version"]) || credential.secret_id !== item.profile_id || !revision(credential.secret_version)))) return undefined;
  const endpoint = profileEndpoint(item.endpoint);
  if (endpoint === undefined || endpoint !== item.endpoint) return undefined;
  return { schema_version: 1, profile_id: item.profile_id, connector_id: item.connector_id, ...(item.display_name === undefined ? {} : { display_name: item.display_name as string }), endpoint,
    owner: { kind: "instance_admin" }, revision: item.revision, enabled: item.enabled,
    ...(item.authentication === undefined ? {} : { authentication: item.authentication as "none" | "oauth" }),
    credential: item.credential === null ? null : { secret_id: item.profile_id, secret_version: credential!.secret_version as number } };
}

export function parseEnvelope(value: unknown): CredentialEnvelope | undefined {
  const item = object(value);
  if (item === undefined || !exact(item, ["schema_version", "key_id", "iv", "ciphertext"]) || item.schema_version !== 1
    || !isCapabilityIdentifier(item.key_id) || typeof item.iv !== "string" || !/^[A-Za-z0-9_-]{16}$/u.test(item.iv)
    || typeof item.ciphertext !== "string" || item.ciphertext.length < 24 || item.ciphertext.length > CONNECTOR_LIMITS.envelope_bytes
    || !/^[A-Za-z0-9_-]+$/u.test(item.ciphertext)) return undefined;
  return { schema_version: 1, key_id: item.key_id, iv: item.iv, ciphertext: item.ciphertext };
}

export function validProfileEnvelope(profile: ConnectionProfile, envelope: unknown): boolean {
  return profile.credential === null ? envelope === null : parseEnvelope(envelope) !== undefined;
}

export function parseProfileCommand(value: unknown): ProfileCommand | undefined {
  const item = object(value);
  if (item === undefined || !isCapabilityIdentifier(item.profile_id)) return undefined;
  if (item.action === "connect") {
    if (!displayName(item) || !exact(item, namedKeys(item, ["action", "profile_id", "connector_id", "endpoint", "authentication"]))
      || !isCapabilityIdentifier(item.connector_id) || !["none", "oauth"].includes(item.authentication as string)) return undefined;
    const endpoint = profileEndpoint(item.endpoint);
    return endpoint === undefined ? undefined : { action: "connect", profile_id: item.profile_id, connector_id: item.connector_id, endpoint,
      authentication: item.authentication as "none" | "oauth", ...(item.display_name === undefined ? {} : { display_name: item.display_name as string }) };
  }
  if (Object.hasOwn(item, "authentication")) return undefined;
  if (item.action === "create_oauth") {
    if (!displayName(item) || !exact(item, namedKeys(item, ["action", "profile_id", "connector_id", "endpoint"])) || !isCapabilityIdentifier(item.connector_id)) return undefined;
    const endpoint = profileEndpoint(item.endpoint);
    return endpoint === undefined ? undefined : { action: "create_oauth", profile_id: item.profile_id, connector_id: item.connector_id, ...(item.display_name === undefined ? {} : { display_name: item.display_name as string }), endpoint };
  }
  if (item.action === "create") {
    if (!displayName(item) || !exact(item, namedKeys(item, ["action", "profile_id", "connector_id", "endpoint", "credential"])) || !isCapabilityIdentifier(item.connector_id)) return undefined;
    const endpoint = profileEndpoint(item.endpoint), credential = parseCredential(item.credential);
    return endpoint === undefined || credential === undefined ? undefined : { action: "create", profile_id: item.profile_id, connector_id: item.connector_id, ...(item.display_name === undefined ? {} : { display_name: item.display_name as string }), endpoint, credential };
  }
  if (!revision(item.expected_revision)) return undefined;
  if (item.action === "rotate") {
    if (!exact(item, ["action", "profile_id", "expected_revision", "credential"])) return undefined;
    const credential = parseCredential(item.credential);
    return credential === undefined ? undefined : { action: "rotate", profile_id: item.profile_id, expected_revision: item.expected_revision, credential };
  }
  if (!["enable", "disable", "rekey"].includes(item.action as string) || !exact(item, ["action", "profile_id", "expected_revision"])) return undefined;
  return { action: item.action as "enable" | "disable" | "rekey", profile_id: item.profile_id, expected_revision: item.expected_revision };
}
