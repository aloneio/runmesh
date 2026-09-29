import { CONNECTOR_LIMITS } from "../../contracts/connectors.js";
import { isConfiguredSecret } from "../../contracts/deployment-secrets.js";

const unavailable = (): Error => new Error("central_credential_unavailable");
export const OAUTH_KEY_ID = "internal-control-v1";
export const encodeBytes = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
export function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > CONNECTOR_LIMITS.envelope_bytes) throw unavailable();
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  if (encodeBytes(bytes) !== value) throw unavailable();
  return bytes;
}

/** Derive a non-exportable OAuth key from the existing deployment secret.
 * HKDF separates this purpose and namespace from internal request signing. */
export async function deriveOAuthKey(namespace: string, secret: unknown): Promise<CryptoKey> {
  let material: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (!isConfiguredSecret(secret) || !namespace || namespace.length > 256) throw unavailable();
    const encoder = new TextEncoder(); material = encoder.encode(secret);
    const source = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256",
      salt: encoder.encode("runmesh/oauth/encryption/v1"), info: encoder.encode(namespace) },
    source, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } catch { throw unavailable(); }
  finally { material?.fill(0); }
}
