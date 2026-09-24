import { CONNECTOR_LIMITS, type ConnectionProfile, type CredentialCipher } from "../../contracts/connectors.js";
import { parseCredential, parseEnvelope, parseProfile } from "../../contracts/connector-values.js";
import { credentialUnavailable, decodeBytes, encodeBytes, loadCipherKey } from "./keyring.js";

/** Standard WebCrypto AES-256-GCM with a random 96-bit IV and authenticated identity.
 * https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
 * Construction is inert and never reads the keyring or touches storage. */
export function createCredentialCipher(namespace: string, loadKeyring: () => unknown, reservedSecrets: () => readonly (string | undefined)[] = () => []): CredentialCipher {
  function aad(profile: ConnectionProfile, keyId: string): Uint8Array<ArrayBuffer> {
    if (!namespace || namespace.length > 256 || profile.credential === null) throw credentialUnavailable();
    return new TextEncoder().encode(JSON.stringify(["runmesh-credential-v1", namespace, profile.profile_id,
      profile.connector_id, profile.endpoint, profile.owner.kind, profile.credential.secret_id, profile.credential.secret_version, keyId]));
  }
  return {
    async seal(profileValue, credentialValue) {
      let plaintext: Uint8Array<ArrayBuffer> | undefined;
      try {
        const profile = parseProfile(profileValue), credential = parseCredential(credentialValue);
        if (profile === undefined || credential === undefined) throw credentialUnavailable();
        const selected = await loadCipherKey(loadKeyring(), undefined, reservedSecrets());
        const iv = crypto.getRandomValues(new Uint8Array(12));
        plaintext = new TextEncoder().encode(JSON.stringify(credential));
        const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
          additionalData: aad(profile, selected.key_id), tagLength: 128 }, selected.key, plaintext);
        const envelope = parseEnvelope({ schema_version: 1, key_id: selected.key_id, iv: encodeBytes(iv), ciphertext: encodeBytes(new Uint8Array(encrypted)) });
        if (envelope === undefined) throw credentialUnavailable();
        return envelope;
      } catch { throw credentialUnavailable(); }
      finally { plaintext?.fill(0); }
    },
    async open(profileValue, envelopeValue) {
      let plaintext: Uint8Array<ArrayBuffer> | undefined;
      try {
        const profile = parseProfile(profileValue), envelope = parseEnvelope(envelopeValue);
        if (profile === undefined || envelope === undefined) throw credentialUnavailable();
        const selected = await loadCipherKey(loadKeyring(), envelope.key_id, reservedSecrets());
        const iv = decodeBytes(envelope.iv);
        if (iv.byteLength !== 12) throw credentialUnavailable();
        plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv,
          additionalData: aad(profile, selected.key_id), tagLength: 128 }, selected.key, decodeBytes(envelope.ciphertext)));
        if (plaintext.byteLength > CONNECTOR_LIMITS.token_bytes + 64) throw credentialUnavailable();
        const result = parseCredential(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
        if (result === undefined) throw credentialUnavailable();
        return result;
      } catch { throw credentialUnavailable(); }
      finally { plaintext?.fill(0); }
    },
  };
}
