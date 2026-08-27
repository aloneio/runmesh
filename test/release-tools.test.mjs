import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildManifest, releaseArtifactName, releaseTag, validateManifest } from "../scripts/release-manifest.mjs";
import { signReleaseManifest, verifyReleaseManifest } from "../scripts/release-signature.mjs";

const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const productVersion = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
async function fixture() { const root = await mkdtemp(join(tmpdir(), "runmesh-release-tools-")); return { root, cleanup: () => rm(root, { recursive: true, force: true }) }; }

test("builds a single portable development artifact manifest from the product version", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, releaseArtifactName(productVersion)), "portable runner artifact");
    const manifest = await buildManifest({ releaseDirectory: f.root, version: productVersion, commitSha: "a".repeat(40), publishedAt: "2026-08-27T00:00:00Z" });
    assert.equal(manifest.tag, releaseTag(productVersion));
    assert.equal(manifest.prerelease, true);
    assert.equal(manifest.channel, "dev");
    assert.deepEqual(manifest.artifacts[0], {
      name: releaseArtifactName(productVersion),
      platform: "node",
      architecture: "portable",
      node_major_min: 20,
      url: `https://github.com/aloneio/runmesh/releases/download/v${productVersion}/${releaseArtifactName(productVersion)}`,
      size: "portable runner artifact".length,
      sha256: "949071a9bf3f3499241d75a0b5e93ac800158e12d3a456f8520c315f4cd6c07f",
    });
    assert.throws(() => validateManifest({ ...manifest, tag: `v${productVersion}-tampered` }, productVersion));
    await assert.rejects(buildManifest({ releaseDirectory: f.root, version: "9.9.9", commitSha: "a".repeat(40), publishedAt: "2026-08-27T00:00:00Z" }), /must match root package\.json/);
  } finally { await f.cleanup(); }
});

test("signs and rejects a tampered manifest with Ed25519", async () => {
  const f = await fixture();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519"); const keyId = "test-key";
    const keyring = join(f.root, "trust-keyring.json"); const manifest = join(f.root, "manifest.json"); const signature = join(f.root, "manifest.sig"); const descriptor = join(f.root, "manifest.signature.json");
    await writeFile(keyring, JSON.stringify({ schema_version: 1, keys: [{ key_id: keyId, algorithm: "ed25519", public_key_pem: publicKey.export({ type: "spki", format: "pem" }) }] }));
    await writeFile(manifest, JSON.stringify({ version: productVersion }));
    await signReleaseManifest({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: keyring, keyId, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) });
    await verifyReleaseManifest({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: keyring, expectedKeyId: keyId });
    await writeFile(manifest, JSON.stringify({ version: `${productVersion}-tampered` }));
    await assert.rejects(verifyReleaseManifest({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: keyring, expectedKeyId: keyId }), /verification failed/);
    assert.equal((await readFile(signature, "utf8")).trim().length > 0, true);
  } finally { await f.cleanup(); }
});
