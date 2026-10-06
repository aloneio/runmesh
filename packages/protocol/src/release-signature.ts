import { FIXED_RELEASE_KEY_ID, FIXED_RELEASE_PUBLIC_KEY_PEM } from "./release-trust.js";

export interface ReleaseTrust { readonly key_id: string; readonly public_key_pem: string; }
export const RUNNER_RELEASE_TRUST: ReleaseTrust = { key_id: FIXED_RELEASE_KEY_ID, public_key_pem: FIXED_RELEASE_PUBLIC_KEY_PEM };
function base64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error("Release signature encoding is invalid.");
  const decoded = atob(value);
  if (btoa(decoded) !== value) throw new Error("Release signature encoding is invalid.");
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> { return Uint8Array.from(bytes); }
/** Verify the exact downloaded bytes before parsing or consuming any manifest field. */
export async function verifyRunnerReleaseSignature(manifest: Uint8Array, signature: Uint8Array, descriptor: Uint8Array, trust: ReleaseTrust = RUNNER_RELEASE_TRUST): Promise<unknown> {
  if (manifest.byteLength === 0 || manifest.byteLength > 65536 || signature.byteLength > 1024 || descriptor.byteLength > 16384) throw new Error("Release metadata exceeds its size limit.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parsed: unknown = JSON.parse(decoder.decode(descriptor));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Release signature descriptor is invalid.");
  const d = parsed as Record<string, unknown>;
  if (d.schema_version !== 1 || d.algorithm !== "ed25519" || d.key_id !== trust.key_id || d.encoding !== "base64" || d.signed_file !== "manifest.json") throw new Error("Release signature descriptor is invalid.");
  const keyMatch = /^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=]+)\n-----END PUBLIC KEY-----\n?$/u.exec(trust.public_key_pem);
  if (keyMatch?.[1] === undefined) throw new Error("Release trust key is invalid.");
  const sig = base64(decoder.decode(signature).trim());
  if (sig.byteLength !== 64) throw new Error("Release signature is invalid.");
  const key = await crypto.subtle.importKey("spki", base64(keyMatch[1]), { name: "Ed25519" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "Ed25519" }, key, sig, owned(manifest))) throw new Error("Release signature does not verify.");
  return JSON.parse(decoder.decode(manifest));
}
