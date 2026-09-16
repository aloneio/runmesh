import assert from "node:assert/strict";

const commit = /^[a-f0-9]{40}$/u, hash = /^[a-f0-9]{64}$/u;
const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u;
export function baselineError(code, message) { return Object.assign(new Error(`${code}: ${message}`), { code }); }

export function validateStableReleaseProof(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "published stable proof is required");
  assert.deepEqual(Object.keys(value).sort(), ["commit_sha", "manifest_sha256", "release_id"]);
  assert.ok(Number.isSafeInteger(value.release_id) && value.release_id > 0);
  assert.match(value.commit_sha, commit); assert.match(value.manifest_sha256, hash);
  return Object.freeze({ ...value });
}

/** Pure checks only. The adapter obtains the manifest by signature verification
 * against a keyring read from the fixed main commit, never from the download. */
export function stableBaseline({ mainSha, version, state, release, tag, manifest, manifestSha256, mainIncluded }) {
  assert.match(mainSha, commit); assert.match(version, stable);
  if (state?.version !== version || state.state !== "released" || state.release_branch !== "main") {
    throw baselineError("stable_baseline_unpublished", "main must have reviewed published-release evidence; a version bump alone is not a release");
  }
  if (mainIncluded !== true) throw baselineError("stable_baseline_not_in_dev", "sync the selected main baseline into dev through a reviewed merge before releasing");
  assert.ok(release && Number.isSafeInteger(release.id) && release.id > 0);
  assert.equal(release.tag_name, `v${version}`, "main and latest published stable version differ");
  assert.equal(release.draft, false); assert.equal(release.prerelease, false); assert.equal(release.immutable, true);
  assert.equal(tag.tag, release.tag_name); assert.equal(tag.object?.type, "commit");
  assert.match(state.release_commit, commit); assert.match(state.manifest_sha256, hash);
  assert.equal(tag.object.sha, state.release_commit, "release tag differs from reviewed publication");
  assert.equal(manifest.version, version); assert.equal(manifest.tag, release.tag_name);
  assert.equal(manifest.channel, "stable"); assert.equal(manifest.prerelease, false);
  assert.equal(manifest.commit_sha, state.release_commit); assert.equal(manifestSha256, state.manifest_sha256);
  return Object.freeze({ stable_sha: mainSha, stable_version: version,
    stable_release: validateStableReleaseProof({ release_id: release.id, commit_sha: state.release_commit, manifest_sha256: manifestSha256 }) });
}

export function assertBaselineUnchanged(plan, observed) {
  if (plan.schema_version !== 2) throw baselineError("legacy_dev_plan", "an unpublished legacy plan lacks published-stable evidence; use a new batch, not a rewritten plan");
  validateStableReleaseProof(plan.stable_release); validateStableReleaseProof(observed.stable_release);
  if (plan.stable_version !== observed.stable_version || Object.keys(plan.stable_release).some(key => plan.stable_release[key] !== observed.stable_release[key])) {
    throw baselineError("dev_release_superseded", "the published stable baseline changed; this unpublished batch cannot be published or renumbered");
  }
}
