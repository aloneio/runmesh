import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTrustedReleaseKey } from "./release-signature.mjs";

/** Extract only literal source-reviewed bootstrap constants, without running
 * Worker code or accepting a downloaded installer as a source of trust. */
export function installerPublicationContract(source) {
  const literal = name => {
    const matches = [...source.matchAll(new RegExp(`^export const ${name} = ("(?:[^"\\\\]|\\\\.)*")(?: as const)?;`, "gm"))];
    assert.equal(matches.length, 1, `exactly one literal ${name} is required`);
    return JSON.parse(matches[0][1]);
  };
  return { version: literal("FIXED_RELEASE_VERSION"), key_id: literal("FIXED_RELEASE_KEY_ID"),
    public_key_pem: literal("FIXED_RELEASE_PUBLIC_KEY_PEM"), channel: literal("FIXED_RELEASE_CHANNEL") };
}

export function validateStablePublication({ version, packageVersion, state, installer, keyId, trustedKey, requireCandidate = true }) {
  assert.match(version, /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u, "stable publication requires a stable version");
  assert.equal(version, packageVersion); assert.equal(state?.version, version);
  assert.equal(state.release_branch, "main");
  assert.ok(requireCandidate ? state.state === "candidate" : ["candidate", "released"].includes(state.state), "prepare a reviewed candidate lifecycle before publishing a new stable release");
  if (state.state === "candidate") {
    assert.ok(state.release_commit === undefined || state.release_commit === null, "candidate cannot reuse a prior release commit");
    assert.ok(state.manifest_sha256 === undefined || state.manifest_sha256 === null, "candidate cannot reuse prior publication evidence");
  } else {
    assert.match(state.release_commit, /^[a-f0-9]{40}$/u); assert.match(state.manifest_sha256, /^[a-f0-9]{64}$/u);
  }
  assert.equal(installer.version, version, "review the hosted installer version before publishing");
  assert.equal(installer.channel, "stable"); assert.equal(installer.key_id, keyId);
  assert.equal(trustedKey?.key_id, keyId); assert.equal(trustedKey.algorithm, "ed25519");
  const embedded = createPublicKey(installer.public_key_pem), trusted = createPublicKey(trustedKey.public_key_pem);
  assert.equal(embedded.asymmetricKeyType, "ed25519"); assert.equal(trusted.asymmetricKeyType, "ed25519");
  assert.ok(embedded.export({ type: "spki", format: "der" }).equals(trusted.export({ type: "spki", format: "der" })), "hosted installer key differs from reviewed trust keyring");
  return { version, key_id: keyId, state: state.state, channel: "stable" };
}

export async function checkStablePublication(root, version, keyId, requireCandidate = true) {
  const read = path => readFile(resolve(root, path), "utf8");
  const installer = installerPublicationContract(await read("apps/worker/src/domain/release-config.ts"));
  const trustedKey = await loadTrustedReleaseKey(resolve(root, "release/trust-keyring.json"), keyId ?? installer.key_id);
  return validateStablePublication({ version, packageVersion: JSON.parse(await read("package.json")).version,
    state: JSON.parse(await read("release/release-state.json")), installer, keyId: keyId ?? installer.key_id, trustedKey, requireCandidate });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, "Use stable-publication.mjs <version> <key-id>");
  console.log(JSON.stringify(await checkStablePublication(fileURLToPath(new URL("../", import.meta.url)), process.argv[2], process.argv[3])));
}
