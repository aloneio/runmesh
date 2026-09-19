import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { proposedCiFiles } from "../scripts/ci-remediation-layout.mjs";
import { parseCi, validateCiWiring } from "../scripts/ci-policy.mjs";
import { UPLOAD_ACTION } from "../scripts/ci-contract.mjs";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
async function baseline() {
  const frozen = JSON.parse(await read("test/fixtures/ci-before-remediation.json"));
  assert.equal(frozen.source_commit, "d4e1e334817f82b82d60489b3443cdb19b87ff39");
  return frozen.input;
}
test("CI integration proposal is deterministic and does not mutate its input", async () => {
  const input = await baseline(), copy = structuredClone(input);
  const first = proposedCiFiles(input), second = proposedCiFiles(input);
  assert.deepEqual(first, second); assert.deepEqual(input, copy);
  assert.equal(validateCiWiring(JSON.parse(first.files["package.json"]), first.files[".github/workflows/ci.yml"], first.files[".gitlab-ci.yml"]).blocking_jobs, 4);
});
test("CI integration preserves native, LTS and generated main-admission jobs", async () => {
  const input = await baseline(), result = proposedCiFiles(input);
  const old = parseCi(input.github), next = parseCi(result.files[".github/workflows/ci.yml"]);
  const expectedNative = structuredClone(old.jobs["native-runner"]);
  expectedNative.steps.push({ run: "node --test test/installer-download.test.mjs test/installer-concurrency.test.mjs" });
  assert.deepEqual(expectedNative, next.jobs["native-runner"]);
  assert.deepEqual(old.jobs["runner-lts"], next.jobs["runner-lts"]);
  assert.equal(result.files[".gitlab-ci.yml"].split("# BEGIN GENERATED MAIN SOURCE POLICY")[1], input.gitlab.split("# BEGIN GENERATED MAIN SOURCE POLICY")[1]);
});
test("Release proposal gates signing, preserves main/version/signature checks and does not cancel publication", async () => {
  const input = await baseline(), result = proposedCiFiles(input);
  const old = parseCi(input.release), next = parseCi(result.files[".github/workflows/release.yml"]);
  assert.deepEqual(old.concurrency, next.concurrency);
  assert.equal(next.concurrency["cancel-in-progress"], false);
  const steps = next.jobs.release.steps;
  const signer = steps.findIndex(step => step.name === "Sign and verify manifest and local release assets");
  assert.ok(steps.findIndex(step => step.run === "node scripts/check-release-readiness.mjs") < signer);
  assert.ok(steps.findIndex(step => step.run === "node scripts/check-crossforge-ci.mjs") < signer);
  assert.ok(steps.some(step => step.uses === UPLOAD_ACTION));
  for (const field of ["state", "version", "branch"]) assert.ok(!Object.hasOwn(next, field));
  assert.ok(result.files[".github/workflows/release.yml"].includes('test "$RELEASE_VERSION" = "0.1.3"'));
  assert.ok(result.files[".github/workflows/release.yml"].includes('test "$immutable" = true'));
});
test("Dependency proposal opens reviewed updates and has no deployment or write credentials", async () => {
  const result = proposedCiFiles(await baseline());
  const bot = parseCi(result.files[".github/dependabot.yml"]);
  assert.ok(bot.updates.every(item => item["target-branch"] === "dev" && item.schedule.interval === "weekly"));
  const workflow = parseCi(result.files[".github/workflows/dependency-watch.yml"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(!result.files[".github/workflows/dependency-watch.yml"].includes("secrets."));
  assert.ok(workflow.on.schedule.length === 1);
});
test("CI proposal refuses a drifted baseline instead of overwriting missing tests", async () => {
  const input = await baseline(); input.github = input.github.replace("npm run test:unit", "npm run something-else");
  assert.throws(() => proposedCiFiles(input));
});
