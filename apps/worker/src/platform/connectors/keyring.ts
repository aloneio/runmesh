import { CONNECTOR_LIMITS } from "../../contracts/connectors.js";
import { isCapabilityIdentifier } from "../../contracts/capabilities.js";

export const credentialUnavailable = (): Error => new Error("central_credential_unavailable");
export const encodeBytes = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
export function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > CONNECTOR_LIMITS.envelope_bytes) throw credentialUnavailable();
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  if (encodeBytes(bytes) !== value) throw credentialUnavailable();
  return bytes;
}

/** Independent, bounded deployment keyring. No key is exported or stored in SQLite. */
export async function loadCipherKey(raw: unknown, requestedId: string | undefined, reserved: readonly (string | undefined)[]): Promise<{ key_id: string; key: CryptoKey }> {
  let material: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (typeof raw !== "string" || raw.length > CONNECTOR_LIMITS.keyring_bytes) throw credentialUnavailable();
    const item = JSON.parse(raw) as Record<string, unknown>;
    if (typeof item !== "object" || item === null || Array.isArray(item) || item.schema_version !== 1
      || !isCapabilityIdentifier(item.active_key_id) || Object.keys(item).sort().join(",") !== "active_key_id,keys,schema_version"
      || typeof item.keys !== "object" || item.keys === null || Array.isArray(item.keys)) throw credentialUnavailable();
    const entries = Object.entries(item.keys), seen = new Set<string>();
    if (entries.length === 0 || entries.length > CONNECTOR_LIMITS.keys || !Object.hasOwn(item.keys, item.active_key_id)) throw credentialUnavailable();
    const id = requestedId ?? item.active_key_id;
    if (!isCapabilityIdentifier(id)) throw credentialUnavailable();
    for (const [keyId, value] of entries) {
      if (!isCapabilityIdentifier(keyId) || typeof value !== "string" || value.length !== 43 || seen.has(value)
        || reserved.some(secret => secret !== undefined && secret === value)) throw credentialUnavailable();
      const bytes = decodeBytes(value);
      if (bytes.byteLength !== 32) throw credentialUnavailable();
      if (keyId === id) material = bytes; else bytes.fill(0);
      seen.add(value);
    }
    if (material === undefined) throw credentialUnavailable();
    const key = await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return { key_id: id, key };
  } catch { throw credentialUnavailable(); }
  finally { material?.fill(0); }
}
