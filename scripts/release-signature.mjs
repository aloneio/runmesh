import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export async function loadTrustedReleaseKey(keyringPath, keyId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId)) throw new Error("release signing key ID is invalid");
  const value = JSON.parse(await readFile(keyringPath, "utf8"));
  if (!isTrustKeyring(value)) throw new Error("release trust keyring has an invalid schema");
  const matches = value.keys.filter((key) => key.key_id === keyId);
  if (matches.length !== 1) throw new Error("release signing key ID is missing or ambiguous in the trust keyring");
  const key = matches[0];
  try {
    const parsed = createPublicKey(key.public_key_pem);
    if (parsed.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
  } catch {
    throw new Error("release trust key is not a valid Ed25519 public key");
  }
  return key;
}

export async function signReleaseManifest(input) {
  if (input.privateKeyPem === undefined || input.privateKeyPem.trim().length === 0) throw new Error("RELEASE_SIGNING_KEY is required");
  const trusted = await loadTrustedReleaseKey(input.keyringPath, input.keyId);
  let privateKey;
  try {
    privateKey = createPrivateKey(input.privateKeyPem);
  } catch {
    throw new Error("RELEASE_SIGNING_KEY is not a valid private key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("RELEASE_SIGNING_KEY must be an Ed25519 private key");
  const derived = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const expected = createPublicKey(trusted.public_key_pem).export({ type: "spki", format: "der" });
  if (!derived.equals(expected)) throw new Error("RELEASE_SIGNING_KEY does not match the selected trust-keyring key");
  const manifest = await readFile(input.manifestPath);
  const signature = sign(null, manifest, privateKey);
  await writeFile(input.signaturePath, `${signature.toString("base64")}\n`, "utf8");
  await writeFile(input.descriptorPath, `${JSON.stringify({ schema_version: 1, algorithm: "ed25519", key_id: trusted.key_id, encoding: "base64" }, null, 2)}\n`, "utf8");
}

export async function verifyReleaseManifest(input) {
  const descriptor = JSON.parse(await readFile(input.descriptorPath, "utf8"));
  if (!isSignatureDescriptor(descriptor)) throw new Error("release signature descriptor has an invalid schema");
  if (input.expectedKeyId !== undefined && descriptor.key_id !== input.expectedKeyId) throw new Error("release signature key ID does not match the selected key");
  const trusted = await loadTrustedReleaseKey(input.keyringPath, descriptor.key_id);
  const encoded = (await readFile(input.signaturePath, "utf8")).trim();
  if (!BASE64.test(encoded)) throw new Error("release signature is not canonical base64");
  const signature = Buffer.from(encoded, "base64");
  if (signature.length === 0 || signature.toString("base64") !== encoded) throw new Error("release signature is malformed");
  if (!verify(null, await readFile(input.manifestPath), createPublicKey(trusted.public_key_pem), signature)) throw new Error("release manifest signature verification failed");
}

function isTrustKeyring(value) {
  if (!isObject(value) || value.schema_version !== 1 || !Array.isArray(value.keys)) return false;
  const ids = new Set();
  return value.keys.every((key) => isTrustedKey(key) && !ids.has(key.key_id) && (ids.add(key.key_id), true));
}
function isTrustedKey(value) {
  return isObject(value) && typeof value.key_id === "string" && value.algorithm === "ed25519" && typeof value.public_key_pem === "string" && value.public_key_pem.length > 0;
}
function isSignatureDescriptor(value) {
  return isObject(value) && value.schema_version === 1 && value.algorithm === "ed25519" && typeof value.key_id === "string" && value.encoding === "base64";
}
function isObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

async function main(argv) {
  const [command, manifestPath, signaturePath, descriptorPath, keyringPath, keyId] = argv;
  if (command === "validate-key" && manifestPath !== undefined && signaturePath !== undefined && descriptorPath === undefined && keyringPath === undefined) {
    await loadTrustedReleaseKey(manifestPath, signaturePath); return;
  }
  if (command === "sign" && manifestPath !== undefined && signaturePath !== undefined && descriptorPath !== undefined && keyringPath !== undefined && keyId !== undefined) {
    await signReleaseManifest({ manifestPath, signaturePath, descriptorPath, keyringPath, keyId, privateKeyPem: process.env.RELEASE_SIGNING_KEY }); return;
  }
  if (command === "verify" && manifestPath !== undefined && signaturePath !== undefined && descriptorPath !== undefined && keyringPath !== undefined) {
    await verifyReleaseManifest({ manifestPath, signaturePath, descriptorPath, keyringPath, ...(keyId === undefined ? {} : { expectedKeyId: keyId }) }); return;
  }
  throw new Error("usage: release-signature.mjs <validate-key|sign|verify> <manifest> <signature> <descriptor> <keyring> [key-id]");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
