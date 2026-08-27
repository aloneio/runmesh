import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELEASE_TAG, RELEASE_VERSION, buildManifest, validateManifest } from "../scripts/release-manifest.mjs";
import { signReleaseManifest, verifyReleaseManifest } from "../scripts/release-signature.mjs";

async function fixture() { const root = await mkdtemp(join(tmpdir(), "runmesh-release-tools-")); return { root, cleanup: () => rm(root, { recursive: true, force: true }) }; }

test("builds immutable development manifest", async () => {
  const f = await fixture();
  try {
    for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"]) await writeFile(join(f.root, `runmesh-runner-${RELEASE_VERSION}-${platform}.tgz`), platform);
    const manifest = await buildManifest({ releaseDirectory: f.root, commitSha: "a".repeat(40), publishedAt: "2026-08-27T00:00:00Z" });
    assert.equal(manifest.tag, RELEASE_TAG); assert.equal(manifest.prerelease, true); assert.equal(manifest.channel, "dev"); assert.equal(manifest.artifacts.length, 5);
    assert.throws(() => validateManifest({ ...manifest, tag: "v0.1.0" }));
  } finally { await f.cleanup(); }
});

test("signs and rejects a tampered manifest with Ed25519", async () => {
  const f = await fixture();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "test-key";
    const keyring = join(f.root, "trust-keyring.json"); const manifest = join(f.root, "manifest.json"); const signature = join(f.root, "manifest.sig"); const descriptor = join(f.root, "manifest.signature.json");
    await writeFile(keyring, JSON.stringify({ schema_version: 1, keys: [{ key_id: keyId, algorithm: "ed25519", public_key_pem: publicKey.export({ type: "spki", format: "pem" }) }] }));
    await writeFile(manifest, JSON.stringify({ version: RELEASE_VERSION }));
    await signReleaseManifest({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: keyring, keyId, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) });
    await verifyReleaseManifest({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: keyring, expectedKeyId: keyId });
    await writeFile(manifest, JSON.stringify({ version: "tampered" }));
    await assert.rejects(verifyReleaseManifest({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: keyring, expectedKeyId: keyId }), /verification failed/);
    assert.equal((await readFile(signature, "utf8")).trim().length > 0, true);
  } finally { await f.cleanup(); }
});
