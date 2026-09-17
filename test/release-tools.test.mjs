import { writeReleaseValidation, releaseValidationModule } from "../scripts/generate-release-validation.mjs";
import { validateReleaseHealth } from "../scripts/check-live-release-prereqs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildManifest, releaseArtifactName, releaseTag, validateManifest } from "../scripts/release-manifest.mjs";
import { verifyReleaseAssets } from "../scripts/release-verify.mjs";
import { signReleaseManifest, verifyReleaseManifest } from "../scripts/release-signature.mjs";
import { resolveTrustedTaskkillPath } from "../scripts/windows-tools.mjs";
import { MAX_RELEASE_ASSET_BYTES, readBoundedReleaseFile } from "../scripts/release-io.mjs";
import { AGGREGATE_JOBS, checkCommand } from "../scripts/ci-contract.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const execFileAsync = promisify(execFile);
const productVersion = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
async function fixture() { const root = await mkdtemp(join(tmpdir(), "runmesh-release-tools-")); return { root, cleanup: () => rm(root, { recursive: true, force: true }) }; }

test("pins manually-dispatched releases to the triggering main commit", async () => {
  const workflow = (await readFile(join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8")).replace(/\r\n/gu, "\n");
  assert.equal(workflow.includes("if: github.ref == 'refs/heads/main'"), false);
  assert.equal(workflow.includes("ref: ${{ github.sha }}"), true);
  assert.equal(workflow.includes("timeout-minutes: 45"), true);
  assert.equal(workflow.includes('test "$GITHUB_REPOSITORY" = "aloneio/runmesh"'), true);
  assert.equal(workflow.includes('test "$GITHUB_REF" = "refs/heads/main"'), true);
  assert.equal(workflow.includes('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'), true);
  assert.equal(workflow.includes('test "$(git rev-parse origin/main)" = "$GITHUB_SHA"'), true);
  assert.equal(workflow.includes('node scripts/stable-publication.mjs "$RELEASE_VERSION" "$RELEASE_SIGNING_KEY_ID"'), true);
  assert.equal(/test "\$RELEASE_VERSION" = "\d+\.\d+\.\d+"/u.test(workflow), false);
  assert.equal(workflow.includes('test "$RELEASE_VERSION" = "$ROOT_VERSION"'), true);
  assert.equal(workflow.lastIndexOf('git fetch --no-tags origin main') > workflow.indexOf('Verify tag and release do not already exist'), true);
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
  assert.equal(workflow.includes("contents: read"), true);
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
  const publishIndex = workflow.indexOf("Publish verified stable release");
  const publishTipFetchIndex = workflow.indexOf("git fetch --no-tags origin main", publishIndex);
  const publishTipAssertIndex = workflow.indexOf('test "$(git rev-parse origin/main)" = "$GITHUB_SHA"', publishIndex);
  assert.ok(publishIndex >= 0 && publishTipFetchIndex > publishIndex && publishTipAssertIndex > publishTipFetchIndex, "publish must re-check the protected main tip");
  assert.equal(workflow.includes('git push origin "v${RELEASE_VERSION}"'), false);
  assert.equal(workflow.includes("sha256sum *.tgz manifest.json manifest.sig manifest.signature.json LICENSE NOTICE THIRD_PARTY_NOTICES.md trust-keyring.json > SHA256SUMS"), true);
  assert.equal(workflow.includes("npm sbom"), false);
  assert.equal(workflow.includes("sbom.spdx.json"), false);
  const actionRefs = [...workflow.matchAll(/^\s+(?:-\s+)?uses:\s+([^\s#]+)/gmu)].map((match) => match[1]);
  assert.ok(actionRefs.length > 0);
  assert.ok(actionRefs.every((ref) => ref === "./.github/workflows/ci.yml" || /^[^@]+@[0-9a-f]{40}$/u.test(ref)), `mutable GitHub Action ref: ${actionRefs.join(", ")}`);
  const ciWorkflow = (await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8")).replace(/\r\n/gu, "\n");
  const ciActionRefs = [...ciWorkflow.matchAll(/^\s+(?:-\s+)?uses:\s+([^\s#]+)/gmu)].map((match) => match[1]);
  assert.ok(ciActionRefs.length > 0);
  assert.ok(ciActionRefs.every((ref) => /^[^@]+@[0-9a-f]{40}$/u.test(ref)), `mutable GitHub Action ref in ci.yml: ${ciActionRefs.join(", ")}`);
  assert.equal(ciWorkflow.includes("persist-credentials: false"), true);
  const gitlabWorkflow = (await readFile(join(repositoryRoot, ".gitlab-ci.yml"), "utf8")).replace(/\r\n/gu, "\n");
  // Cloudflare Workers Builds owns deployment for both connected repositories;
  // GitLab CI mirrors GitHub's verification lane and must not require a
  // separate Wrangler token or carry a competing deployment job.
  assert.equal(gitlabWorkflow.includes("cloudflare_deploy:"), false);
  assert.equal(gitlabWorkflow.includes("wrangler deploy"), false);
  assert.equal(gitlabWorkflow.includes("CLOUDFLARE_API_TOKEN"), false);
  for (const id of ["worker_default", "worker_prod", "transport"]) {
    const command = checkCommand(id);
    assert.equal(gitlabWorkflow.includes(command), true, `GitLab verify must include ${command}`);
  }
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
    assert.equal(manifest.prerelease, false);
    assert.equal(manifest.channel, "stable");
    assert.deepEqual(manifest.artifacts[0], {
      name: releaseArtifactName(productVersion),
      platform: "node",
      architecture: "portable",
      node_major_min: 22,
      url: `https://github.com/aloneio/runmesh/releases/download/v${productVersion}/${releaseArtifactName(productVersion)}`,
      size: "portable runner artifact".length,
      sha256: "949071a9bf3f3499241d75a0b5e93ac800158e12d3a456f8520c315f4cd6c07f",
    });
    assert.throws(() => validateManifest({ ...manifest, tag: `v${productVersion}-tampered` }, productVersion));
    assert.throws(() => validateManifest({ ...manifest, published_at: "2026-02-30T00:00:00Z" }, productVersion), /invalid Runmesh release manifest/);
    assert.equal(releaseTag("1.2.3"), "v1.2.3");
    assert.throws(() => releaseTag("1.2.3-rc.1"), /release version is invalid/);
    assert.throws(() => validateManifest({ ...manifest, channel: "dev", prerelease: true }, productVersion), /invalid Runmesh release manifest/);
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
      channel: "stable",
      prerelease: false,
      commit_sha: "a".repeat(40),
      protocol_min: 2,
      protocol_max: 2,
      published_at: "2026-08-27T00:00:00Z",
      artifacts: [{ name: releaseArtifactName(productVersion), platform: "node", architecture: "portable", node_major_min: 22, url: `https://github.com/aloneio/runmesh/releases/download/${releaseTag(productVersion)}/${releaseArtifactName(productVersion)}`, size: MAX_RELEASE_ASSET_BYTES + 1, sha256: "a".repeat(64) }],
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
    assert.match(shell, /"\$NODE" "\$NPM_CLI" --userconfig "\$NPM_CONFIG_USERCONFIG" --globalconfig "\$NPM_CONFIG_GLOBALCONFIG" install/u);
    assert.match(shell, /\(\s+cd "\$TMP"\s+"\$NODE" "\$NPM_CLI" --userconfig[\s\S]*?install[\s\S]*?--ignore-scripts[\s\S]*?--offline/u);
    assert.match(shell, /node-v22\.23\.2/u);
    assert.match(shell, /NODE_SHA256/u);
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


test("stable publication requires the owner and the complete same-SHA CI workflow", async () => {
  const release = await readFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
  const ci = await readFile(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  assert.ok(release.includes("uses: ./.github/workflows/ci.yml"));
  assert.ok(release.includes("needs: [verification]"));
  assert.ok(release.includes("github.actor == github.repository_owner"));
  assert.ok(release.includes("github.triggering_actor == github.repository_owner"));
  assert.ok(release.includes("--prerelease=false"));
  assert.ok(ci.includes("workflow_call:"));
  const verifyAll = ci.slice(ci.indexOf("  verify-all:"), ci.indexOf("\n  browser:", ci.indexOf("  verify-all:")));
  for (const job of AGGREGATE_JOBS) assert.ok(verifyAll.includes(`      - ${job}`), `verify-all must require ${job}`);
  assert.match(ci, /node:\n\s+- 22\.23\.2\n\s+- 24\.21\.0/u);
  assert.ok(!ci.includes("runner-node20"));
});


test("release publication rejects stale or incomplete public deployment contracts", () => {
  const health={ok:true,service:"runmesh-agent-control-plane",worker_id:"worker-production",release_gate:{test_mode_disabled:true,canonical_public_origin_configured:true},release_readiness:{contract:"release-chain-audit-v1",rpc_authorization_complete:true},job_history:{backend:"packed_d1",protocol:1},audit_history:{backend:"d1",binding_configured:true}};
  assert.doesNotThrow(()=>validateReleaseHealth(health));
  for(const key of ["release_readiness","job_history","audit_history"]) {
    const invalid=structuredClone(health);delete invalid[key];assert.throws(()=>validateReleaseHealth(invalid));
  }
  const stale=structuredClone(health);stale.release_readiness.rpc_authorization_complete=false;assert.throws(()=>validateReleaseHealth(stale));
  const unbound=structuredClone(health);unbound.audit_history.binding_configured=false;assert.throws(()=>validateReleaseHealth(unbound));
});


test("AR15 generates one bounded field validator without evaluating source", async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, "apps/worker/src/domain");
    await mkdir(directory, { recursive: true });
    const input = join(directory, "release-manifest.ts");
    await writeFile(input, 'throw new Error("must not evaluate authored input"); export const marker: number = 1;\n');
    assert.equal(await writeReleaseValidation(f.root), true);
    assert.equal(await writeReleaseValidation(f.root), false);
    const first = await readFile(join(f.root, "apps/worker/src/generated-release-validation.ts"), "utf8");
    await writeFile(input, 'export const marker: number = 2;\n');
    assert.equal(await writeReleaseValidation(f.root), true);
    assert.notEqual(await readFile(join(f.root, "apps/worker/src/generated-release-validation.ts"), "utf8"), first);
    await writeFile(input, 'import type { Stats } from "node:fs"; export const marker = 1;\n');
    await assert.rejects(releaseValidationModule(f.root), /no runtime or type imports/u);
    await writeFile(input, " ".repeat(32769));
    await assert.rejects(releaseValidationModule(f.root), /bounded/u);
    assert.equal(await readFile(join(repositoryRoot, "apps/worker/src/generated-release-validation.ts"), "utf8"), await releaseValidationModule(repositoryRoot));
  } finally { await f.cleanup(); }
});

test("AR15 Worker and both generated installer verifiers agree on signed manifest fields", { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const modules = {};
    for (const [name, source] of Object.entries({ installer: "installer.ts", io: "distribution/release-io.ts", selection: "domain/release-selection.ts" })) {
      const outfile = join(f.root, `${name}.mjs`);
      await build({ entryPoints: [join(repositoryRoot, "apps/worker/src", source)], outfile, bundle: true, platform: "node", format: "esm", target: "node22" });
      modules[name] = await import(pathToFileURL(outfile).href);
    }
    const version = productVersion.replace(/(\d+)$/u, value => String(Number(value) + 1)) + "-dev.0";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const trust = { key_id: "synthetic-parity-key", public_key_pem: String(publicKey.export({ type: "spki", format: "pem" })) };
    const target = { ...modules.installer.installerReleaseTarget(version, "dev"), release_key_id: trust.key_id, public_key_pem: trust.public_key_pem };
    const shell = modules.installer.renderPosixInstaller("https://worker.test", "dedicated_user", target);
    const powershell = modules.installer.renderPowerShellInstaller("https://worker.test", "dedicated_user", target);
    const posixCode = /<<'RUNMESH_VERIFY'\n([\s\S]+?)\nRUNMESH_VERIFY\n/u.exec(shell)?.[1];
    const psStart = powershell.indexOf("Invoke-LoggedStep 'Verifying Runner'");
    const powerShellCode = /@'\n([\s\S]+?)\n'@ \| & \$NodePath --input-type=module - \$TempRoot/u.exec(powershell.slice(psStart))?.[1];
    assert.ok(posixCode && powerShellCode, "extract the actual generated verifier, not a hand-written predicate");
    assert.equal(posixCode, powerShellCode);
    const paths = [join(f.root, "posix-verifier.mjs"), join(f.root, "powershell-verifier.mjs")];
    await writeFile(paths[0], posixCode); await writeFile(paths[1], powerShellCode);
    const artifact = Buffer.from("synthetic portable artifact, never installed");
    const digest = createHash("sha256").update(artifact).digest("hex");
    const base = { schema_version: 1, project: "runmesh", version, tag: `v${version}`, channel: "dev", prerelease: true, commit_sha: "a".repeat(40), protocol_min: 2, protocol_max: 2, published_at: "2026-09-16T08:00:00Z", artifacts: [{ name: target.artifact_name, platform: "node", architecture: "portable", node_major_min: 22, url: target.artifact_url, size: artifact.length, sha256: digest }] };
    const metadata = { draft: false, prerelease: true, immutable: true, tag_name: `v${version}`, published_at: base.published_at, assets: ["LICENSE", "NOTICE", "SHA256SUMS", "THIRD_PARTY_NOTICES.md", "manifest.json", "manifest.sig", "manifest.signature.json", "trust-keyring.json", target.artifact_name].map(name => ({ name })) };
    const descriptor = modules.selection.developmentDescriptor(metadata);
    assert.ok(descriptor);
    const changeArtifact = value => ({ ...base, artifacts: [{ ...base.artifacts[0], ...value }] });
    const cases = [
      ["valid", base, true],
      ["valid leap day", { ...base, published_at: "2028-02-29T08:00:00Z" }, true],
      ["unknown signed fields", { ...base, optional_future_metadata: "safe" }, true],
      ["impossible month", { ...base, published_at: "2026-99-99T99:99:99Z" }, false],
      ["normalized invalid day", { ...base, published_at: "2026-02-30T08:00:00Z" }, false],
      ["invalid leap day", { ...base, published_at: "2026-02-29T08:00:00Z" }, false],
      ["offset timestamp", { ...base, published_at: "2026-09-16T08:00:00+00:00" }, false],
      ["non-string timestamp", { ...base, published_at: [base.published_at] }, false],
      ["coerced commit", { ...base, commit_sha: [base.commit_sha] }, false],
      ["wrong protocol", { ...base, protocol_max: 99 }, false],
      ["wrong channel", { ...base, channel: "stable" }, false],
      ["wrong prerelease flag", { ...base, prerelease: false }, false],
      ["extra artifact", { ...base, artifacts: [...base.artifacts, ...base.artifacts] }, false],
      ["null artifact", { ...base, artifacts: [null] }, false],
      ["non-integer size", changeArtifact({ size: 1.5 }), false],
      ["oversized artifact", changeArtifact({ size: modules.installer.MAX_RELEASE_ASSET_BYTES + 1 }), false],
      ["coerced size", changeArtifact({ size: String(artifact.length) }), false],
      ["coerced digest", changeArtifact({ sha256: [digest] }), false],
      ["untrusted artifact URL", changeArtifact({ url: "https://example.invalid/untrusted.tgz" }), false],
      ["wrong artifact name", changeArtifact({ name: "unexpected.tgz" }), false],
    ];
    for (const [name, manifest, expected] of cases) {
      // Every negative fixture has a genuine valid test signature, so these
      // failures prove field validation rather than an unrelated crypto error.
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const signature = Buffer.from(sign(null, manifestBytes, privateKey).toString("base64"));
      const signatureDescriptor = Buffer.from(JSON.stringify({ schema_version: 1, algorithm: "ed25519", key_id: trust.key_id, encoding: "base64", signed_file: "manifest.json" }));
      const assets = new Map([[target.manifest_url, manifestBytes], [target.signature_url, signature], [target.signature_descriptor_url, signatureDescriptor]]);
      const fetchImpl = async input => { const bytes = assets.get(String(input)); assert.ok(bytes, "fixed release URLs only"); return new Response(bytes); };
      const accepted = await modules.io.verifyDevelopmentRunnerRelease(descriptor, fetchImpl, trust).then(() => true, () => false);
      assert.equal(accepted, expected, `Worker: ${name}`);
      await writeFile(join(f.root, "manifest.json"), manifestBytes);
      await writeFile(join(f.root, "manifest.sig"), signature);
      await writeFile(join(f.root, "manifest.signature.json"), signatureDescriptor);
      await writeFile(join(f.root, target.artifact_name), artifact);
      await writeFile(join(f.root, "SHA256SUMS"), `${digest}  ${target.artifact_name}\n`);
      for (const path of paths) {
        const result = await execFileAsync(process.execPath, [path, f.root], { timeout: 5_000, maxBuffer: 128 * 1024 }).then(() => true, () => false);
        assert.equal(result, expected, `${path}: ${name}`);
      }
    }
  } finally { await f.cleanup(); }
});

// A subprocess watchdog makes a blocking-open regression fail instead of
// stranding the test worker or leaving a FIFO reader alive after cleanup.
test("rejects FIFO release inputs without waiting for a writer", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const fifo = join(f.root, "input.fifo"), alias = join(f.root, "input-link");
    await execFileAsync("mkfifo", [fifo], { timeout: 3000, windowsHide: true });
    await symlink(fifo, alias);
    const module = new URL("../scripts/release-io.mjs", import.meta.url).href;
    const probe = `import assert from "node:assert/strict";
      import { readBoundedReleaseFile } from ${JSON.stringify(module)};
      await assert.rejects(readBoundedReleaseFile(process.argv[1], "release input"), /not a regular file/u);`;
    for (const path of [fifo, alias]) {
      await execFileAsync(process.execPath, ["--input-type=module", "-e", probe, path], {
        timeout: 3000, killSignal: "SIGKILL", windowsHide: true,
      });
    }
  } finally { await f.cleanup(); }
});
