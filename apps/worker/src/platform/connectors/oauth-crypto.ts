import { OAuthFault, type OAuthCipher } from "../../contracts/oauth.js";
import { catalogJson } from "../../contracts/catalog-json.js";
import { parseEnvelope } from "../../contracts/connector-values.js";
import { decodeBytes, encodeBytes, loadCipherKey } from "./keyring.js";

/** Separate AAD namespace from bearer profiles. No reusable raw-key cache. */
export function createOAuthCipher(namespace: string, keyring: () => unknown, reserved: () => readonly (string | undefined)[]): OAuthCipher {
  const aad = (context: string, keyId: string) => {
    if (!namespace || namespace.length > 256 || !context || context.length > 4096) throw new OAuthFault("unavailable");
    return new TextEncoder().encode(JSON.stringify(["runmesh-oauth-v1", namespace, keyId, context]));
  };
  return {
    async seal(context, value) {
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      try {
        const canonical = catalogJson(value, 5500);
        if (canonical === undefined) throw new OAuthFault("invalid_request");
        const key = await loadCipherKey(keyring(), undefined, reserved()), iv = crypto.getRandomValues(new Uint8Array(12));
        bytes = new TextEncoder().encode(canonical);
        const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(context, key.key_id), tagLength: 128 }, key.key, bytes);
        const envelope = parseEnvelope({ schema_version: 1, key_id: key.key_id, iv: encodeBytes(iv), ciphertext: encodeBytes(new Uint8Array(ciphertext)) });
        if (envelope === undefined) throw new OAuthFault("unavailable");
        return envelope;
      } catch { throw new OAuthFault("unavailable"); } finally { bytes?.fill(0); }
    },
    async open(context, raw) {
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      try {
        const envelope = parseEnvelope(raw);
        if (envelope === undefined) throw new OAuthFault("unavailable");
        const key = await loadCipherKey(keyring(), envelope.key_id, reserved());
        bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBytes(envelope.iv),
          additionalData: aad(context, key.key_id), tagLength: 128 }, key.key, decodeBytes(envelope.ciphertext)));
        if (bytes.length > 5500) throw new OAuthFault("unavailable");
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch { throw new OAuthFault("unavailable"); } finally { bytes?.fill(0); }
    },
  };
}
export const oauthRandom = (): string => encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
export const oauthChallenge = async (verifier: string): Promise<string> => encodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
