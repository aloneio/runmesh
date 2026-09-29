import { encodeBase64Url, decodeBase64Url } from "../contracts/base64url.js";
import { isConfiguredSecret } from "../contracts/deployment-secrets.js";
import { catalogJson } from "../contracts/catalog-json.js";
import { SECRET_STORAGE_LIMITS, parseEncryptedSecret, type SecretStorage } from "../contracts/secret-storage.js";

const keyId = "internal-control-v1";
const unavailable = (): Error => new Error("secret_storage_unavailable");

/** One at-rest cipher for recoverable credentials. These format labels remain
 * stable so moving the implementation does not invalidate stored ciphertext. */
export function createSecretStorage(namespace: string, secret: () => unknown): SecretStorage {
  const encoder = new TextEncoder();
  const key = async (): Promise<CryptoKey> => {
    let material: Uint8Array<ArrayBuffer> | undefined;
    try {
      const value = secret();
      if (!isConfiguredSecret(value) || !namespace || namespace.length > 256) throw unavailable();
      material = encoder.encode(value);
      const source = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
      return await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256",
        salt: encoder.encode("runmesh/oauth/encryption/v1"), info: encoder.encode(namespace) },
      source, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    } finally { material?.fill(0); }
  };
  const aad = (context: string): Uint8Array<ArrayBuffer> => {
    if (!namespace || namespace.length > 256 || !context || context.length > 4096) throw unavailable();
    return encoder.encode(JSON.stringify(["runmesh-oauth-v2", namespace, keyId, context]));
  };
  return {
    async seal(context, value) {
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      try {
        const canonical = catalogJson(value, SECRET_STORAGE_LIMITS.plaintext_bytes);
        if (canonical === undefined) throw unavailable();
        const additionalData = aad(context), derived = await key(), iv = crypto.getRandomValues(new Uint8Array(12));
        bytes = encoder.encode(canonical);
        const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, derived, bytes);
        const envelope = parseEncryptedSecret({ schema_version: 1, key_id: keyId, iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(new Uint8Array(ciphertext)) });
        if (envelope === undefined) throw unavailable();
        return envelope;
      } catch { throw unavailable(); } finally { bytes?.fill(0); }
    },
    async open(context, raw) {
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      try {
        const envelope = parseEncryptedSecret(raw);
        if (envelope === undefined || envelope.key_id !== keyId) throw unavailable();
        const iv = decodeBase64Url(envelope.iv, 16), ciphertext = decodeBase64Url(envelope.ciphertext, SECRET_STORAGE_LIMITS.ciphertext_bytes);
        if (iv === undefined || ciphertext === undefined) throw unavailable();
        const additionalData = aad(context), derived = await key();
        bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, derived, ciphertext));
        if (bytes.length > SECRET_STORAGE_LIMITS.plaintext_bytes) throw unavailable();
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch { throw unavailable(); } finally { bytes?.fill(0); }
    },
  };
}
