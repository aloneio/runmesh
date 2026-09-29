import { isCapabilityIdentifier } from "./capabilities.js";

const plaintextBytes = 65_536;
export const SECRET_STORAGE_LIMITS = Object.freeze({ plaintext_bytes: plaintextBytes,
  ciphertext_bytes: Math.ceil((plaintextBytes + 16) * 4 / 3) });

export interface EncryptedSecret {
  readonly schema_version: 1;
  readonly key_id: string;
  readonly iv: string;
  readonly ciphertext: string;
}
/** Applications receive this port; only composition creates the crypto adapter. */
export interface SecretStorage {
  seal(context: string, value: unknown): Promise<EncryptedSecret>;
  open(context: string, envelope: EncryptedSecret): Promise<unknown>;
}

export function parseEncryptedSecret(value: unknown): EncryptedSecret | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const keys = ["schema_version", "key_id", "iv", "ciphertext"];
  if (Object.keys(item).length !== keys.length || !keys.every(key => Object.hasOwn(item, key)) || item.schema_version !== 1
    || !isCapabilityIdentifier(item.key_id) || typeof item.iv !== "string" || !/^[A-Za-z0-9_-]{16}$/u.test(item.iv)
    || typeof item.ciphertext !== "string" || item.ciphertext.length < 23 || item.ciphertext.length > SECRET_STORAGE_LIMITS.ciphertext_bytes
    || !/^[A-Za-z0-9_-]+$/u.test(item.ciphertext)) return undefined;
  return { schema_version: 1, key_id: item.key_id, iv: item.iv, ciphertext: item.ciphertext };
}
