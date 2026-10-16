import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCi } from "./ci-policy.mjs";

const stableSource = "node scripts/check-release-privacy.mjs source --notes \"docs/releases/${RELEASE_VERSION}.md\"";
const stableAssets = "node scripts/check-release-privacy.mjs assets release/assets --notes \"docs/releases/${RELEASE_VERSION}.md\"";
const devSource = "node scripts/check-release-privacy.mjs source";
const devAssets = "node scripts/check-release-privacy.mjs assets .dev-release/assets --plan .dev-release/plan.json";
const beforePublish = "steps.publication-preflight.outputs.already_published != 'true'";

function gate(steps, command, condition) {
  assert.ok(Array.isArray(steps), "release_privacy_missing_steps");
  const matches = steps.filter(step => step.run === command);
  assert.equal(matches.length, 1, "release_privacy_missing_or_duplicate_gate");
  const result = matches[0];
  assert.equal(result.if, condition, "release_privacy_gate_condition");
  assert.equal(result["continue-on-error"], undefined, "release_privacy_gate_fail_open");
  assert.equal(result["working-directory"], undefined, "release_privacy_gate_cwd");
  assert.equal(result.shell, undefined, "release_privacy_gate_shell");
  return steps.indexOf(result);
}
function findNamed(steps, name) {
  const index = steps.findIndex(step => step.name === name);
  assert.ok(index >= 0, "release_privacy_expected_step_missing");
  return index;
}
export function validateReleasePrivacyWiring(stableText, devText) {
  const stable = parseCi(stableText), dev = parseCi(devText);
  const stableSteps = stable.jobs?.release?.steps, planSteps = dev.jobs?.plan?.steps, devSteps = dev.jobs?.publish?.steps;
  const stableSourceIndex = gate(stableSteps, stableSource, undefined);
  const stableAssetsIndex = gate(stableSteps, stableAssets, undefined);
  assert.ok(stableSourceIndex < findNamed(stableSteps, "Verify generated release inputs after installing dependencies"),
    "release_privacy_source_must_precede_installation");
  assert.ok(stableAssetsIndex > findNamed(stableSteps, "Sign and verify manifest and local release assets")
    && stableAssetsIndex < findNamed(stableSteps, "Preserve signed release assets as an unpublished CI artifact")
    && stableAssetsIndex < findNamed(stableSteps, "Create annotated release tag"),
    "release_privacy_assets_must_precede_publish");
  const stableTag = stableSteps[findNamed(stableSteps, "Create annotated release tag")].run;
  assert.ok(stableTag?.includes("'tagger[name]=aloneio'") && stableTag?.includes("'tagger[email]=git@aloneio.aleeas.com'"),
    "release_privacy_tag_author_missing");
  const sourceIndex = gate(planSteps, devSource, undefined);
  assert.ok(sourceIndex < planSteps.findIndex(step => step.id === "plan"), "release_privacy_source_must_precede_plan");
  const assetIndex = gate(devSteps, devAssets, beforePublish);
  assert.ok(assetIndex > findNamed(devSteps, "Sign using the existing trusted release key")
    && assetIndex < findNamed(devSteps, "Publish an immutable prerelease, never Latest, with download verification"),
    "release_privacy_assets_must_precede_publish");
  assert.equal(stable.jobs?.verification?.uses, "./.github/workflows/ci.yml", "release_privacy_stable_requires_full_ci");
  assert.equal(dev.jobs?.verification?.uses, "./.github/workflows/ci.yml", "release_privacy_dev_requires_full_ci");
  return { stable: true, development: true };
}
export function checkReleasePrivacyWiring() {
  const stable = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const dev = readFileSync(new URL("../.github/workflows/dev-release.yml", import.meta.url), "utf8");
  return validateReleasePrivacyWiring(stable, dev);
}
