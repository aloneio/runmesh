import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { stableBaseline, assertBaselineUnchanged } from "../scripts/dev-release/baseline-policy.mjs";
import { observeStableBaseline, assertCurrentBaseline } from "../scripts/dev-release/baseline.mjs";
import { createDevPlan, validateDevPlan, nextDevVersion, releaseCadence } from "../scripts/dev-release/policy.mjs";
import { installerPublicationContract, validateStablePublication, checkStablePublication } from "../scripts/stable-publication.mjs";

function fixture(version = "0.1.3") {
  const mainSha = "a".repeat(40), sourceSha = "b".repeat(40), releasedSha = "c".repeat(40), manifestHash = "e".repeat(64);
  const data = { mainSha, version, mainIncluded: true,
    state: { version, state: "released", release_branch: "main", release_commit: releasedSha, manifest_sha256: manifestHash },
    release: { id: 9, tag_name: `v${version}`, draft: false, prerelease: false, immutable: true },
    tag: { tag: `v${version}`, object: { type: "commit", sha: releasedSha } },
    manifest: { version, tag: `v${version}`, channel: "stable", prerelease: false, commit_sha: releasedSha }, manifestSha256: manifestHash };
  const calls = [], current = { main: mainSha, release: data.release };
  const io = {
    git: async (...args) => {
      calls.push(["git", ...args]);
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse") return data.mainSha;
      if (args[0] === "merge-base") { assert.deepEqual(args, ["merge-base", "--is-ancestor", mainSha, sourceSha]); if (!data.mainIncluded) throw new Error("not ancestor"); return ""; }
      if (args[0] === "show") {
        assert.ok(args[1].startsWith(`${mainSha}:`));
        if (args[1].endsWith(":package.json")) return JSON.stringify({ version: data.version });
        if (args[1].endsWith(":release/release-state.json")) return JSON.stringify(data.state);
        if (args[1].endsWith(":release/trust-keyring.json")) return "source-reviewed-keyring";
      }
      throw new Error("unexpected Git operation");
    },
    api: async path => {
      calls.push(["api", path]);
      if (path === "releases/latest") return current.release;
      if (path.startsWith("git/ref/tags/")) return { object: { type: "tag", sha: "d".repeat(40) } };
      if (path.startsWith("git/tags/")) return data.tag;
      if (path === "git/ref/heads/main") return { object: { type: "commit", sha: current.main } };
      throw new Error("unexpected API operation");
    },
    readManifest: async (_release, keyring) => {
      calls.push(["verifyManifest"]); assert.equal(keyring, "source-reviewed-keyring");
      return { manifest: data.manifest, manifestSha256: data.manifestSha256 };
    },
  };
  const makePlan = () => createDevPlan({ ...stableBaseline(data), source_sha: sourceSha, source_tree: "f".repeat(40), push_number: 5, run_id: 123, published_at: "2026-09-16T00:00:00Z" });
  return { data, io, calls, current, sourceSha, makePlan };
}

test("main ancestry and immutable historical release commit are separate verified identities", async () => {
  const f = fixture(), observed = await observeStableBaseline(f.sourceSha, f.io);
  assert.equal(observed.stable_sha, f.data.mainSha); assert.equal(observed.stable_release.commit_sha, f.data.state.release_commit);
  assert.notEqual(observed.stable_sha, observed.stable_release.commit_sha); await assertCurrentBaseline(f.makePlan(), f.io);
});
for (const version of ["0.1.4", "0.2.0", "1.0.0", "2.17.99"]) test(`verified main ${version} preserves cadence and advances the correct patch`, async () => {
  const f = fixture(version), baseline = await observeStableBaseline(f.sourceSha, f.io);
  const plan = createDevPlan({ ...baseline, source_sha: f.sourceSha, source_tree: "f".repeat(40), push_number: 10, run_id: 456, published_at: "2026-09-16T00:00:00Z" });
  assert.equal(plan.version, nextDevVersion(version, 10)); assert.ok(plan.version.endsWith("-dev.1")); assert.equal(releaseCadence(9).remaining, 1);
});
test("unmerged main and candidate-only version bumps cannot become release baselines", async () => {
  for (const mutate of [f => { f.data.mainIncluded = false; }, f => { f.data.state.state = "candidate"; }, f => { f.data.state.version = "0.1.4"; }, f => { f.data.state.release_branch = "dev"; }]) {
    const f = fixture(); mutate(f); await assert.rejects(observeStableBaseline(f.sourceSha, f.io));
    assert.equal(f.calls.some(c => c[0] === "api" || c[0] === "verifyManifest"), false);
  }
});
for (const [key, value] of [["tag_name", "v0.1.2"], ["draft", true], ["prerelease", true], ["immutable", false]]) test(`invalid latest stable ${key} is rejected`, async () => {
  const f = fixture(); f.data.release[key] = value; await assert.rejects(observeStableBaseline(f.sourceSha, f.io));
});
test("tag, signed commit, channel and reviewed manifest hash must all agree", async () => {
  for (const mutate of [f => { f.data.tag.object.sha = "9".repeat(40); }, f => { f.data.manifest.commit_sha = "8".repeat(40); }, f => { f.data.manifestSha256 = "7".repeat(64); }, f => { f.data.manifest.channel = "dev"; }]) {
    const f = fixture(); mutate(f); await assert.rejects(observeStableBaseline(f.sourceSha, f.io));
  }
});
test("signature and API failures cannot produce a baseline", async () => {
  const f = fixture(); f.io.readManifest = async () => { throw new Error("invalid signature"); }; await assert.rejects(observeStableBaseline(f.sourceSha, f.io), /invalid signature/u);
  const g = fixture(); g.io.api = async () => { throw new Error("HTTP 403"); }; await assert.rejects(observeStableBaseline(g.sourceSha, g.io), /403/u);
});
test("main and Latest are rechecked after signature observation", async () => {
  for (const mutate of [f => { f.current.main = "9".repeat(40); }, f => { f.current.release = { ...f.data.release, id: 10 }; }]) {
    const f = fixture(), read = f.io.readManifest;
    f.io.readManifest = async (...args) => { const result = await read(...args); mutate(f); return result; };
    await assert.rejects(observeStableBaseline(f.sourceSha, f.io), /changed during/u);
  }
});
test("pending old batch is superseded without renumbering its frozen plan", async () => {
  const f = fixture(), plan = f.makePlan(), before = JSON.stringify(plan);
  f.current.release = { ...f.data.release, id: 10, tag_name: "v0.1.4" };
  await assert.rejects(assertCurrentBaseline(plan, f.io), { code: "dev_release_superseded" }); assert.equal(JSON.stringify(plan), before);
  const changed = { ...stableBaseline(f.data), stable_release: { ...plan.stable_release, manifest_sha256: "9".repeat(64) } };
  assert.throws(() => assertBaselineUnchanged(plan, changed), { code: "dev_release_superseded" });
});
test("legacy plans remain readable, but new publication requires schema-two proof", async () => {
  const f = fixture(), { stable_release: _proof, ...base } = f.makePlan(), legacy = { ...base, schema_version: 1 };
  assert.deepEqual(validateDevPlan(legacy), legacy); await assert.rejects(assertCurrentBaseline(legacy, f.io), { code: "legacy_dev_plan" });
  assert.throws(() => createDevPlan({ ...base, schema_version: 1 })); assert.throws(() => validateDevPlan({ ...base, schema_version: 2 }));
});

function publicationFixture(version = "0.1.4") {
  const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  return { version, packageVersion: version, state: { version, state: "candidate", release_branch: "main" }, keyId: "reviewed-key",
    installer: { version, key_id: "reviewed-key", channel: "stable", public_key_pem: pem }, trustedKey: { key_id: "reviewed-key", algorithm: "ed25519", public_key_pem: pem } };
}
test("future stable patch/minor/major candidates pass a matching source-reviewed contract", () => {
  for (const version of ["0.1.4", "0.2.0", "1.0.0", "2.17.99"]) assert.equal(validateStablePublication(publicationFixture(version)).version, version);
});
test("generic stable gate retains lifecycle, version and public-key protections", () => {
  for (const mutate of [f => { f.packageVersion = "0.1.3"; }, f => { f.state.state = "released"; }, f => { f.state.release_branch = "dev"; }, f => { f.state.release_commit = "a".repeat(40); }, f => { f.state.manifest_sha256 = "a".repeat(64); }, f => { f.installer.version = "0.1.3"; }, f => { f.installer.channel = "dev"; }, f => { f.keyId = "unreviewed-key"; }, f => { f.installer.public_key_pem = publicationFixture().installer.public_key_pem; }]) {
    const f = publicationFixture(); mutate(f); assert.throws(() => validateStablePublication(f));
  }
  assert.throws(() => validateStablePublication(publicationFixture("0.1.4-dev.0")), /stable version/u);
});
test("installer contract accepts literals, never expressions or duplicate assignments", () => {
  const f = publicationFixture();
  const source = `export const FIXED_RELEASE_VERSION = "0.1.4";\nexport const FIXED_RELEASE_KEY_ID = "reviewed-key";\nexport const FIXED_RELEASE_PUBLIC_KEY_PEM = ${JSON.stringify(f.installer.public_key_pem)};\nexport const FIXED_RELEASE_CHANNEL = "stable" as const;\n`;
  assert.deepEqual(installerPublicationContract(source), f.installer);
  assert.throws(() => installerPublicationContract(source + 'export const FIXED_RELEASE_VERSION = "0.1.5";'));
  assert.throws(() => installerPublicationContract(source.replace('= "0.1.4";', '= process.env.VERSION;')));
});
test("current installer follows the reviewed lifecycle without a fixed version number", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url)), version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const state = JSON.parse(await readFile(new URL("../release/release-state.json", import.meta.url), "utf8"));
  assert.equal((await checkStablePublication(root, version, undefined, false)).state, state.state);
  if (state.state === "released") await assert.rejects(checkStablePublication(root, version), /candidate lifecycle/u);
  else assert.equal((await checkStablePublication(root, version)).state, "candidate");
});
test("completed-release retry skips signing and today's CI while new publication remains gated", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/dev-release.yml", import.meta.url), "utf8"));
  assert.equal(workflow.jobs.plan.steps.find(step => step.id === "plan").env.GH_TOKEN, "${{ github.token }}");
  const steps = workflow.jobs.publish.steps, gate = steps.findIndex(step => step.id === "publication-preflight");
  const signing = steps.findIndex(step => step.env?.RELEASE_SIGNING_KEY); assert.ok(gate >= 0 && gate < signing);
  for (const step of steps.filter(step => step.env?.RELEASE_SIGNING_KEY || step.run?.includes("publish.mjs"))) assert.equal(step.if, "steps.publication-preflight.outputs.already_published != 'true'");
  const stable = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.ok(stable.includes('node scripts/stable-publication.mjs "$RELEASE_VERSION" "$RELEASE_SIGNING_KEY_ID"'));
  assert.equal(/test "\$RELEASE_VERSION" = "\d+\.\d+\.\d+"/u.test(stable), false);
  assert.ok(stable.includes('test "$(git rev-parse origin/main)" = "$GITHUB_SHA"'));
});
