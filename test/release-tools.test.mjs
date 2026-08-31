import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildManifest, releaseArtifactName, releaseTag, validateManifest } from "../scripts/release-manifest.mjs";
import { verifyReleaseAssets } from "../scripts/release-verify.mjs";
import { signReleaseManifest, verifyReleaseManifest } from "../scripts/release-signature.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const productVersion = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
async function fixture() { const root = await mkdtemp(join(tmpdir(), "runmesh-release-tools-")); return { root, cleanup: () => rm(root, { recursive: true, force: true }) }; }

test("pins manually-dispatched releases to the triggering dev commit", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.equal(workflow.includes("if: github.ref == 'refs/heads/dev'"), true);
  assert.equal(workflow.includes("ref: ${{ github.sha }}"), true);
  assert.equal(workflow.includes("timeout-minutes: 45"), true);
  assert.equal(workflow.includes('test "$GITHUB_REPOSITORY" = "aloneio/runmesh"'), true);
  assert.equal(workflow.includes('test "$GITHUB_REF" = "refs/heads/dev"'), true);
  assert.equal(workflow.includes('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'), true);
  assert.equal(workflow.includes('test "$(git rev-parse origin/dev)" = "$GITHUB_SHA"'), true);
  assert.equal(workflow.includes("https://api.github.com/repos/"), true);
  assert.equal(workflow.includes('test -n "$GH_TOKEN"'), true);
  assert.equal(workflow.includes("node scripts/release-verify.mjs release/download/manifest.json"), true);
  assert.equal(workflow.includes("does not match triggering commit"), true);
  assert.equal(workflow.includes("RELEASE_SIGNING_KEY: ${{ secrets.RELEASE_SIGNING_KEY }}\n    RELEASE_SIGNING_KEY_ID"), false);
  assert.equal(workflow.includes("env:\n          RELEASE_SIGNING_KEY: ${{ secrets.RELEASE_SIGNING_KEY }}"), true);
  assert.equal(workflow.includes("release/download/trust-keyring.json \"$RELEASE_SIGNING_KEY_ID\""), false);
  assert.equal(workflow.includes("cmp release/download/trust-keyring.json release/trust-keyring.json"), true);
  assert.equal(workflow.includes("node scripts/release-verify.mjs release/assets/manifest.json release/assets/manifest.sig"), true);
  assert.equal(workflow.includes("(cd release/assets && sha256sum -c SHA256SUMS)"), true);
  assert.equal(workflow.includes("release/download/trust-keyring.json \"$RELEASE_SIGNING_KEY_ID\""), false);
  assert.equal(workflow.includes("actions/upload-artifact@v4"), true);
  assert.equal(workflow.includes("contents: write"), true);
  assert.equal(workflow.includes("contents: read"), false);
  assert.equal(workflow.includes("gh release create"), true);
  assert.equal(workflow.includes('git push origin "v${RELEASE_VERSION}"'), false);
  assert.equal(workflow.includes("sha256sum *.tgz manifest.json manifest.sig manifest.signature.json LICENSE NOTICE THIRD_PARTY_NOTICES.md trust-keyring.json > SHA256SUMS"), true);
});

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
    assert.throws(() => validateManifest({ ...manifest, published_at: "2026-02-30T00:00:00Z" }, productVersion), /invalid Runmesh development manifest/);
    assert.throws(() => releaseTag("1.2.3"), /release version is invalid/);
    assert.throws(() => releaseTag("01.2.3-dev.1"), /release version is invalid/);
    await assert.rejects(buildManifest({ releaseDirectory: f.root, version: "9.9.9", commitSha: "a".repeat(40), publishedAt: "2026-08-27T00:00:00Z" }), /must match root package\.json/);
  } finally { await f.cleanup(); }
});

test("verifies with an independent trusted keyring instead of an asset-supplied keyring", async () => {
  const f = await fixture();
  try {
    const trusted = generateKeyPairSync("ed25519"); const attacker = generateKeyPairSync("ed25519"); const keyId = "test-key";
    const trustedKeyring = join(f.root, "trusted-keyring.json"); const downloadedKeyring = join(f.root, "downloaded-keyring.json"); const manifest = join(f.root, "manifest.json"); const signature = join(f.root, "manifest.sig"); const descriptor = join(f.root, "manifest.signature.json");
    const keyring = (publicKey) => JSON.stringify({ schema_version: 1, keys: [{ key_id: keyId, algorithm: "ed25519", public_key_pem: publicKey.export({ type: "spki", format: "pem" }) }] });
    await writeFile(trustedKeyring, keyring(trusted.publicKey)); await writeFile(downloadedKeyring, keyring(attacker.publicKey)); await writeFile(manifest, JSON.stringify({ version: productVersion }));
    await signReleaseManifest({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: trustedKeyring, keyId, privateKeyPem: trusted.privateKey.export({ type: "pkcs8", format: "pem" }) });
    await verifyReleaseManifest({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: trustedKeyring, expectedKeyId: keyId });
    await assert.rejects(verifyReleaseManifest({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: downloadedKeyring, expectedKeyId: keyId }), /verification failed/);
  } finally { await f.cleanup(); }
});
test("rejects an artifact replaced after checksums are regenerated", async () => {
  const f = await fixture();
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519"); const keyId = "test-key";
    const keyring = join(f.root, "trust-keyring.json"); const artifact = join(f.root, releaseArtifactName(productVersion)); const manifest = join(f.root, "manifest.json"); const signature = join(f.root, "manifest.sig"); const descriptor = join(f.root, "manifest.signature.json");
    await writeFile(keyring, JSON.stringify({ schema_version: 1, keys: [{ key_id: keyId, algorithm: "ed25519", public_key_pem: publicKey.export({ type: "spki", format: "pem" }) }] }));
    await writeFile(artifact, "original artifact");
    const built = await buildManifest({ releaseDirectory: f.root, version: productVersion, commitSha: "a".repeat(40), publishedAt: "2026-08-27T00:00:00Z" });
    await writeFile(manifest, JSON.stringify(built));
    await signReleaseManifest({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: keyring, keyId, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) });
    await writeFile(artifact, "tampered artifact");
    await assert.rejects(verifyReleaseAssets({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: keyring, expectedKeyId: keyId, expectedVersion: productVersion }), /mismatch/);
  } finally { await f.cleanup(); }
});
test("embeds the independently reviewed fixed release key and immutable installer contract", async () => {
  const f = await fixture();
  try {
    const outfile = join(f.root, "installer.mjs");
    await build({ entryPoints: [join(repositoryRoot, "apps/worker/src/installer.ts")], outfile, bundle: true, platform: "node", format: "esm", target: "node20" });
    const installer = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
      const keyring = JSON.parse(await readFile(join(repositoryRoot, "release/trust-keyring.json"), "utf8"));
      const key = keyring.keys.find((item) => item.key_id === installer.FIXED_RELEASE_KEY_ID);
      assert.equal(installer.FIXED_RELEASE_VERSION, productVersion);
    assert.equal(key?.public_key_pem, installer.FIXED_RELEASE_PUBLIC_KEY_PEM);
    assert.equal(installer.FIXED_ARTIFACT_URL, `https://github.com/aloneio/runmesh/releases/download/v${productVersion}/runmesh-runner-${productVersion}.tgz`);
    const shell = installer.renderPosixInstaller("https://worker.test");
    const powershell = installer.renderPowerShellInstaller("https://worker.test");
    for (const text of [shell, powershell]) {
      assert.equal(text.includes("trust-keyring.json"), false);
      assert.equal(text.includes("@latest"), false);
      assert.equal(text.includes("npmjs.com"), false);
      assert.equal(text.includes("signature does not verify"), true);
      assert.equal(text.includes("artifact size or SHA-256 mismatch"), true);
      assert.equal(text.includes("manifest.signature.json"), true);
      assert.equal(text.includes("SHA256SUMS"), true);
    }
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
