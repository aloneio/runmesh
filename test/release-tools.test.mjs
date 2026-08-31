import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildManifest, releaseArtifactName, releaseTag, validateManifest } from "../scripts/release-manifest.mjs";
import { verifyReleaseAssets } from "../scripts/release-verify.mjs";
import { signReleaseManifest, verifyReleaseManifest } from "../scripts/release-signature.mjs";
import { resolveTrustedTaskkillPath } from "../scripts/windows-tools.mjs";
import { MAX_RELEASE_ASSET_BYTES, readBoundedReleaseFile } from "../scripts/release-io.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const execFileAsync = promisify(execFile);
const productVersion = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
async function fixture() { const root = await mkdtemp(join(tmpdir(), "runmesh-release-tools-")); return { root, cleanup: () => rm(root, { recursive: true, force: true }) }; }

test("pins manually-dispatched releases to the triggering dev commit", async () => {
  const workflow = (await readFile(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8")).replace(/\r\n/gu, "\n");
  assert.equal(workflow.includes("if: github.ref == 'refs/heads/dev'"), false);
  assert.equal(workflow.includes("ref: ${{ github.sha }}"), true);
  assert.equal(workflow.includes("timeout-minutes: 45"), true);
  assert.equal(workflow.includes('test "$GITHUB_REPOSITORY" = "aloneio/runmesh"'), true);
  assert.equal(workflow.includes('test "$GITHUB_REF" = "refs/heads/dev"'), true);
  assert.equal(workflow.includes('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'), true);
  assert.equal(workflow.includes('test "$(git rev-parse origin/dev)" = "$GITHUB_SHA"'), true);
  assert.equal(workflow.includes('test "$RELEASE_VERSION" = "0.1.0-dev.2"'), true);
  assert.equal(workflow.includes('test "$RELEASE_SIGNING_KEY_ID" = "runmesh-preview-2026-01"'), true);
  assert.equal(workflow.lastIndexOf('git fetch --no-tags origin dev') > workflow.indexOf('Verify tag and release do not already exist'), true);
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
  assert.equal(workflow.includes("actions/upload-artifact@v4"), false);
  assert.equal(workflow.includes("contents: write"), true);
  assert.equal(workflow.includes("contents: read"), false);
  assert.equal(workflow.includes("gh release create"), true);
  assert.equal(workflow.includes("failure()"), false, "release workflow must not auto-delete orphan tags");
  assert.equal(workflow.includes("Re-check that the annotated tag still resolves"), true);
  assert.equal(workflow.includes('test "$target_sha" = "$GITHUB_SHA"'), true);
  assert.equal(workflow.includes('cmp "$draft_dir/SHA256SUMS" release/assets/SHA256SUMS'), true);
  assert.equal(workflow.includes('cmp release/download/SHA256SUMS release/assets/SHA256SUMS'), true);
  assert.equal(workflow.includes("Refuse build-generated tracked mutations"), true);
  assert.equal(workflow.lastIndexOf("git diff --exit-code") > workflow.indexOf("npm run build"), true);
  const packIndex = workflow.indexOf("npm pack --workspace=@aloneio/runmesh-runner --pack-destination release/assets");
  const packSizeGateIndex = workflow.indexOf("statSync");
  assert.ok(packIndex >= 0 && packSizeGateIndex > packIndex, "final release pack must have an explicit size gate");
  assert.equal(workflow.includes("size <= 0 || size > 8 * 1024 * 1024"), true);
  const publishIndex = workflow.indexOf("Publish verified development prerelease");
  const publishTipFetchIndex = workflow.indexOf("git fetch --no-tags origin dev", publishIndex);
  const publishTipAssertIndex = workflow.indexOf('test "$(git rev-parse origin/dev)" = "$GITHUB_SHA"', publishIndex);
  assert.ok(publishIndex >= 0 && publishTipFetchIndex > publishIndex && publishTipAssertIndex > publishTipFetchIndex, "publish must re-check the protected dev tip");
  assert.equal(workflow.includes('git push origin "v${RELEASE_VERSION}"'), false);
  assert.equal(workflow.includes("sha256sum *.tgz manifest.json manifest.sig manifest.signature.json LICENSE NOTICE THIRD_PARTY_NOTICES.md trust-keyring.json > SHA256SUMS"), true);
  assert.equal(workflow.includes("npm sbom"), false);
  assert.equal(workflow.includes("sbom.spdx.json"), false);
  const actionRefs = [...workflow.matchAll(/^\s+(?:-\s+)?uses:\s+([^\s#]+)/gmu)].map((match) => match[1]);
  assert.ok(actionRefs.length > 0);
  assert.ok(actionRefs.every((ref) => /^[^@]+@[0-9a-f]{40}$/u.test(ref)), `mutable GitHub Action ref: ${actionRefs.join(", ")}`);
  const ciWorkflow = (await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8")).replace(/\r\n/gu, "\n");
  const ciActionRefs = [...ciWorkflow.matchAll(/^\s+(?:-\s+)?uses:\s+([^\s#]+)/gmu)].map((match) => match[1]);
  assert.ok(ciActionRefs.length > 0);
  assert.ok(ciActionRefs.every((ref) => /^[^@]+@[0-9a-f]{40}$/u.test(ref)), `mutable GitHub Action ref in ci.yml: ${ciActionRefs.join(", ")}`);
  assert.equal(ciWorkflow.includes("persist-credentials: false"), true);
  const gitlabWorkflow = (await readFile(join(repositoryRoot, ".gitlab-ci.yml"), "utf8")).replace(/\r\n/gu, "\n");
  assert.equal(gitlabWorkflow.includes('git fetch --no-tags origin "$CI_COMMIT_BRANCH"'), true);
  assert.equal(gitlabWorkflow.includes('test "$(git rev-parse FETCH_HEAD)" = "$CI_COMMIT_SHA"'), true);
});

test("keeps worker validation fail-closed when a false dry-run value is supplied", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [join(repositoryRoot, "scripts", "validate-worker.mjs"), "--dry-run", "false"], {
      cwd: repositoryRoot,
      windowsHide: true,
    }),
    (error) => error?.code === 1 && /always runs Wrangler in dry-run mode/u.test(String(error?.stderr ?? error?.message ?? "")),
  );
});

test("uses a verified absolute Windows taskkill path for process-tree cleanup", async () => {
  assert.equal(resolveTrustedTaskkillPath({ SystemRoot: "D:\\WinNT" }), "D:\\WinNT\\System32\\taskkill.exe");
  assert.throws(() => resolveTrustedTaskkillPath({ SystemRoot: "D:\\Temp" }), /invalid synthetic Windows system root/u);
  for (const script of ["validate-worker.mjs", "run-e2e.mjs"]) {
    const source = (await readFile(join(repositoryRoot, "scripts", script), "utf8")).replace(/\r\n/gu, "\n");
    assert.equal(source.includes('execFile("taskkill.exe"'), false, `${script} must not resolve taskkill through PATH`);
    assert.equal(source.includes("execFile(taskkill,"), true, `${script} must use the trusted absolute path`);
  }
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

test("rejects release assets that exceed the shared bounded-input contract", async () => {
  const f = await fixture();
  try {
    const artifact = join(f.root, releaseArtifactName(productVersion));
    await writeFile(artifact, "");
    await truncate(artifact, MAX_RELEASE_ASSET_BYTES + 1);
    await assert.rejects(
      readBoundedReleaseFile(artifact, "oversized Runner artifact"),
      /release input limit/u,
    );
    await assert.rejects(
      buildManifest({ releaseDirectory: f.root, version: productVersion, commitSha: "a".repeat(40), publishedAt: "2026-08-27T00:00:00Z" }),
      /release input limit/u,
    );
    const oversizedManifest = {
      schema_version: 1,
      project: "runmesh",
      version: productVersion,
      tag: releaseTag(productVersion),
      channel: "dev",
      prerelease: true,
      commit_sha: "a".repeat(40),
      protocol_min: 2,
      protocol_max: 2,
      published_at: "2026-08-27T00:00:00Z",
      artifacts: [{ name: releaseArtifactName(productVersion), platform: "node", architecture: "portable", node_major_min: 20, url: `https://github.com/aloneio/runmesh/releases/download/${releaseTag(productVersion)}/${releaseArtifactName(productVersion)}`, size: MAX_RELEASE_ASSET_BYTES + 1, sha256: "a".repeat(64) }],
    };
    assert.throws(() => validateManifest(oversizedManifest, productVersion), /invalid manifest artifact/u);
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
    const authenticated = await verifyReleaseManifest({ manifestPath: manifest, signaturePath: signature, descriptorPath: descriptor, keyringPath: trustedKeyring, expectedKeyId: keyId });
    assert.deepEqual(authenticated, await readFile(manifest));
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
    assert.equal(installer.MAX_RELEASE_ASSET_BYTES, 8 * 1024 * 1024);
    assert.ok(Number.isSafeInteger(installer.MAX_RELEASE_ASSET_BYTES));
    assert.ok(installer.MAX_RELEASE_ASSET_BYTES > 262144, "release asset cap must exceed the historical 256 KiB limit");
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
    assert.match(shell, /--max-filesize\s+\d+/u);
    assert.match(shell, /statSync/u);
    assert.match(shell, /size > 8388608/u);
    assert.match(shell, /parseBytes\("manifest\.json", manifestBytes\)/u);
    assert.match(shell, /from "node:fs\/promises"/u);
    assert.doesNotMatch(shell, /import \{ readFile, stat \}/u);
    assert.match(shell, /Buffer\.allocUnsafe/u);
    assert.match(shell, /maxReleaseAssetBytes \+ 1/u);
    assert.ok((shell.match(/handle\.stat\(\)/gu) ?? []).length >= 2, "verifier must fstat before and after bounded reads");
    assert.match(shell, /handle\.read\(/u);
    assert.match(shell, /NPM_CONFIG_USERCONFIG="\$TMP\/npm-user\.npmrc"/u);
    assert.match(shell, /NPM_CONFIG_GLOBALCONFIG="\$TMP\/npm-global\.npmrc"/u);
    assert.match(shell, /export npm_config_userconfig="\$NPM_CONFIG_USERCONFIG" npm_config_globalconfig="\$NPM_CONFIG_GLOBALCONFIG"/u);
    assert.match(shell, /npm --userconfig "\$NPM_CONFIG_USERCONFIG" --globalconfig "\$NPM_CONFIG_GLOBALCONFIG" install/u);
    assert.match(shell, /\(\s+cd "\$TMP"\s+npm --userconfig[\s\S]*?install[\s\S]*?--ignore-scripts[\s\S]*?--offline/u);
    assert.match(powershell, /ContentLength/u);
    assert.match(powershell, /fixed size limit/u);
    assert.match(powershell, /\$EmptyUserConfig = Join-Path \$TempRoot 'empty-user\.npmrc'/u);
    assert.match(powershell, /\$EmptyGlobalConfig = Join-Path \$TempRoot 'empty-global\.npmrc'/u);
    assert.match(powershell, /\$env:NPM_CONFIG_USERCONFIG = \$EmptyUserConfig/u);
    assert.match(powershell, /\$env:NPM_CONFIG_GLOBALCONFIG = \$EmptyGlobalConfig/u);
    assert.match(powershell, /Push-Location -LiteralPath \$TempRoot/u);
    assert.match(powershell, /& \$NpmPath --userconfig \$EmptyUserConfig --globalconfig \$EmptyGlobalConfig install/u);
    assert.match(powershell, /& \$NpmPath --userconfig[\s\S]*?install[\s\S]*?--ignore-scripts[\s\S]*?--offline/u);
    const installationDocs = await readFile(join(repositoryRoot, "docs", "portable-runner-installation.md"), "utf8");
    assert.ok(installationDocs.includes('cd "$NPM_CONFIG_DIR"'));
    assert.ok(installationDocs.includes('sudo npm --userconfig "$NPM_CONFIG_DIR/user.npmrc" --globalconfig "$NPM_CONFIG_DIR/global.npmrc" install'));
    assert.ok(installationDocs.includes('npm.cmd --userconfig $EmptyUserConfig --globalconfig $EmptyGlobalConfig install'));
    assert.ok(installationDocs.includes('Push-Location -LiteralPath $NpmConfigRoot'));
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
