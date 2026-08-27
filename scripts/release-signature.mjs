import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function loadTrustedReleaseKey(keyringPath, keyId) {
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) throw new Error("release signing key ID is invalid");
  const parsed = JSON.parse(await readFile(keyringPath, "utf8"));
  if (!isTrustKeyring(parsed)) throw new Error("release trust keyring has an invalid schema");
  const key = parsed.keys.find((candidate) => candidate.key_id === keyId);
  if (key === undefined) throw new Error("release signing key ID is missing from the trust keyring");
  try { if (createPublicKey(key.public_key_pem).asymmetricKeyType !== "ed25519") throw new Error(); }
  catch { throw new Error("release trust key is not a valid Ed25519 public key"); }
  return key;
}

export async function signReleaseManifest({ manifestPath, signaturePath, descriptorPath, keyringPath, keyId, privateKeyPem }) {
  if (typeof privateKeyPem !== "string" || privateKeyPem.trim() === "") throw new Error("RELEASE_SIGNING_KEY is required");
  const trusted = await loadTrustedReleaseKey(keyringPath, keyId);
  let privateKey;
  try { privateKey = createPrivateKey(privateKeyPem); } catch { throw new Error("RELEASE_SIGNING_KEY is not a valid private key"); }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("RELEASE_SIGNING_KEY must be an Ed25519 private key");
  if (!createPublicKey(privateKey).export({ type: "spki", format: "der" }).equals(createPublicKey(trusted.public_key_pem).export({ type: "spki", format: "der" }))) throw new Error("RELEASE_SIGNING_KEY does not match the selected trust-keyring key");
  const signature = sign(null, await readFile(manifestPath), privateKey);
  await writeFile(signaturePath, `${signature.toString("base64")}\n`, "utf8");
  await writeFile(descriptorPath, `${JSON.stringify({ schema_version: 1, algorithm: "ed25519", key_id: trusted.key_id, encoding: "base64", signed_file: "manifest.json" }, null, 2)}\n`, "utf8");
}

export async function verifyReleaseManifest({ manifestPath, signaturePath, descriptorPath, keyringPath, expectedKeyId }) {
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  if (!isSignatureDescriptor(descriptor)) throw new Error("release signature descriptor has an invalid schema");
  if (expectedKeyId !== undefined && descriptor.key_id !== expectedKeyId) throw new Error("release signature key ID does not match the selected key");
  const trusted = await loadTrustedReleaseKey(keyringPath, descriptor.key_id);
  const encoded = (await readFile(signaturePath, "utf8")).trim();
  if (!BASE64.test(encoded)) throw new Error("release signature is not canonical base64");
  const signature = Buffer.from(encoded, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== encoded) throw new Error("release signature is malformed");
  if (!verify(null, await readFile(manifestPath), createPublicKey(trusted.public_key_pem), signature)) throw new Error("release manifest signature verification failed");
}

function isTrustKeyring(value) { if (!isObject(value) || value.schema_version !== 1 || !Array.isArray(value.keys) || value.keys.length === 0) return false; const ids = new Set(); return value.keys.every((key) => isTrustedKey(key) && !ids.has(key.key_id) && (ids.add(key.key_id), true)); }
function isTrustedKey(value) { return isObject(value) && typeof value.key_id === "string" && KEY_ID.test(value.key_id) && value.algorithm === "ed25519" && typeof value.public_key_pem === "string" && value.public_key_pem.length > 0; }
function isSignatureDescriptor(value) { return isObject(value) && value.schema_version === 1 && value.algorithm === "ed25519" && typeof value.key_id === "string" && KEY_ID.test(value.key_id) && value.encoding === "base64" && value.signed_file === "manifest.json"; }
function isObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

async function main(args) {
  const [command, ...rest] = args;
  if (command === "validate-key" && rest.length === 2) return loadTrustedReleaseKey(rest[0], rest[1]);
  if (command === "sign" && rest.length === 5) return signReleaseManifest({ manifestPath: rest[0], signaturePath: rest[1], descriptorPath: rest[2], keyringPath: rest[3], keyId: rest[4], privateKeyPem: process.env.RELEASE_SIGNING_KEY });
  if (command === "verify" && (rest.length === 4 || rest.length === 5)) return verifyReleaseManifest({ manifestPath: rest[0], signaturePath: rest[1], descriptorPath: rest[2], keyringPath: rest[3], ...(rest[4] === undefined ? {} : { expectedKeyId: rest[4] }) });
  throw new Error("usage: release-signature.mjs validate-key <keyring> <key-id> | sign <manifest> <signature> <descriptor> <keyring> <key-id> | verify <manifest> <signature> <descriptor> <keyring> [key-id]");
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
