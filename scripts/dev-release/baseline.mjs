import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest } from "../release-manifest.mjs";
import { verifyReleaseManifest } from "../release-signature.mjs";
import { readBoundedReleaseFile } from "../release-io.mjs";
import { assertSource, command, git, mainModule, readPlan } from "./io.mjs";
import { githubJson } from "./github.mjs";
import { assertPlanContext } from "./policy.mjs";
import { assertBaselineUnchanged, baselineError, stableBaseline } from "./baseline-policy.mjs";

const evidenceFiles = ["manifest.json", "manifest.sig", "manifest.signature.json"];

/** Read only three bounded signature inputs, not the Runner archive. */
export async function readStableManifest(release, keyringText) {
  assert.ok(Array.isArray(release.assets));
  for (const name of evidenceFiles) {
    const matches = release.assets.filter(asset => asset.name === name);
    assert.equal(matches.length, 1, "missing or duplicate stable signature evidence");
    assert.equal(matches[0].state, "uploaded");
    assert.ok(Number.isSafeInteger(matches[0].size) && matches[0].size > 0 && matches[0].size <= 65536);
  }
  const directory = await mkdtemp(join(tmpdir(), "runmesh-stable-baseline-"));
  try {
    const keyring = join(directory, "trusted-source-keyring.json");
    await writeFile(keyring, keyringText, { flag: "wx" });
    await command("gh", ["release", "download", release.tag_name, "--repo", "aloneio/runmesh", "--dir", directory, ...evidenceFiles.flatMap(name => ["--pattern", name])]);
    for (const name of evidenceFiles) {
      const bytes = await readBoundedReleaseFile(join(directory, name), name);
      assert.ok(bytes.length <= 65536); assert.equal(bytes.length, release.assets.find(asset => asset.name === name).size);
    }
    const bytes = await verifyReleaseManifest({ manifestPath: join(directory, "manifest.json"), signaturePath: join(directory, "manifest.sig"), descriptorPath: join(directory, "manifest.signature.json"), keyringPath: keyring });
    return { manifest: validateManifest(JSON.parse(bytes.toString("utf8")), release.tag_name.slice(1)), manifestSha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Ports keep network observation, ancestry and cryptographic verification
 * testable independently. No code merge, branch write or release mutation. */
export async function observeStableBaseline(sourceSha, io = { git, api: githubJson, readManifest: readStableManifest }) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/u);
  await io.git("fetch", "--no-tags", "origin", "main:refs/remotes/origin/main");
  const mainSha = await io.git("rev-parse", "origin/main"); assert.match(mainSha, /^[a-f0-9]{40}$/u);
  const pkg = JSON.parse(await io.git("show", `${mainSha}:package.json`));
  assert.match(pkg.version, /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u);
  const state = JSON.parse(await io.git("show", `${mainSha}:release/release-state.json`));
  if (state.version !== pkg.version || state.state !== "released" || state.release_branch !== "main") {
    throw baselineError("stable_baseline_unpublished", "main has not completed reviewed stable publication");
  }
  // A release-version string never substitutes for actual code ancestry.
  try { await io.git("merge-base", "--is-ancestor", mainSha, sourceSha); }
  catch { throw baselineError("stable_baseline_not_in_dev", "the fixed dev source must contain the observed main commit; sync main through normal review"); }
  const release = await io.api("releases/latest");
  assert.equal(release.tag_name, `v${pkg.version}`, "main version differs from latest published stable release");
  assert.equal(release.draft, false); assert.equal(release.prerelease, false); assert.equal(release.immutable, true);
  const ref = await io.api(`git/ref/tags/${encodeURIComponent(release.tag_name)}`);
  assert.equal(ref.object?.type, "tag"); assert.match(ref.object.sha, /^[a-f0-9]{40}$/u);
  const tag = await io.api(`git/tags/${ref.object.sha}`);
  const keyring = await io.git("show", `${mainSha}:release/trust-keyring.json`);
  const authenticated = await io.readManifest(release, keyring);
  const baseline = stableBaseline({ mainSha, version: pkg.version, state, release, tag, ...authenticated, mainIncluded: true });
  // Refuse mixed observations if main or Latest moved while reading assets.
  const currentMain = await io.api("git/ref/heads/main"), currentRelease = await io.api("releases/latest");
  assert.equal(currentMain.object?.type, "commit"); assert.equal(currentMain.object?.sha, mainSha, "main changed during baseline observation");
  for (const key of ["id", "tag_name", "draft", "prerelease", "immutable"]) assert.equal(currentRelease[key], release[key], "published stable baseline changed during observation");
  return baseline;
}

export async function assertCurrentBaseline(plan, io) {
  if (plan.schema_version !== 2) throw baselineError("legacy_dev_plan", "unpublished legacy plans require a new batch");
  // Check the stable release identity before ancestry, so a newly published
  // version is reported as a superseded batch instead of a generic Git error.
  const api = io?.api ?? githubJson;
  const latest = await api("releases/latest");
  if (latest.id !== plan.stable_release.release_id || latest.tag_name !== `v${plan.stable_version}`) {
    throw baselineError("dev_release_superseded", "a different stable release is current; the pending batch remains unpublished");
  }
  assertBaselineUnchanged(plan, await observeStableBaseline(plan.source_sha, io));
}

if (mainModule(import.meta.url)) {
  assert.equal(process.argv.length, 3);
  const plan = await readPlan(process.argv[2]); assertPlanContext(plan, process.env); await assertSource(plan);
  await assertCurrentBaseline(plan); console.log(JSON.stringify({ baseline: "verified_current", version: plan.stable_version, source_sha: plan.source_sha }));
}
