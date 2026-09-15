import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { githubMainPromotion, gitlabMainPromotion } from "../scripts/main-promotion-policy.mjs";
import { githubPolicyWorkflow, gitlabPolicyEntrypoint, gitlabPolicyJob, GITLAB_POLICY_MARKER } from "../scripts/promotion-configuration.mjs";

const repo = { id: 123, full_name: "sample/project" };
const event = () => ({ action: "opened", repository: repo, pull_request: { number: 42, state: "open",
  base: { ref: "main", repo }, head: { ref: "dev", repo, sha: "a".repeat(40) } } });
const github = { GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY_ID: "123", GITHUB_REPOSITORY: "sample/project", GITHUB_REF: "refs/pull/42/merge" };
const gitlab = { CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_IID: "42", CI_PROJECT_ID: "123",
  CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "123", CI_MERGE_REQUEST_PROJECT_ID: "123",
  CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "dev", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" };

for (const action of ["opened", "reopened", "synchronize", "edited", "ready_for_review"]) {
  test(`GitHub accepts same-repository dev on ${action}`, () => {
    assert.equal(githubMainPromotion({ ...event(), action }, github).allowed, true);
  });
}
for (const branch of ["main", "feature/change", "Dev", "dev/next", "refs/heads/dev", "dev; exit 0"]) {
  test(`both providers reject disallowed main source ${JSON.stringify(branch)}`, () => {
    const value = event(); value.pull_request.head.ref = branch;
    assert.throws(() => githubMainPromotion(value, github));
    assert.throws(() => gitlabMainPromotion({ ...gitlab, CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: branch }));
  });
}
test("same-name fork dev is not the repository's dev", () => {
  const value = event(); value.pull_request.head.repo = { id: 456, full_name: "fork/project" };
  assert.throws(() => githubMainPromotion(value, github));
  assert.throws(() => gitlabMainPromotion({ ...gitlab, CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "456" }));
  assert.throws(() => gitlabMainPromotion({ ...gitlab, CI_PROJECT_ID: "456", CI_MERGE_REQUEST_SOURCE_PROJECT_ID: "456" }));
});
test("missing/deleted head repository, wrong target and forged repository names fail closed", () => {
  for (const change of [e => delete e.pull_request.head.repo, e => e.pull_request.base.ref = "dev",
    e => e.pull_request.base.repo = { ...repo, id: 124 }, e => e.pull_request.head.repo = { ...repo, full_name: "other/project" },
    e => e.pull_request.head.sha = "not-a-sha", e => e.pull_request.number = 99, e => e.pull_request.state = "closed"]) {
    const value = event(); change(value); assert.throws(() => githubMainPromotion(value, github));
  }
  assert.throws(() => githubMainPromotion({}, github));
  assert.throws(() => githubMainPromotion(event(), {}));
});
test("push/manual/tag events cannot generate a valid main PR source receipt", () => {
  for (const name of ["push", "workflow_dispatch", "workflow_call", "pull_request_target", "merge_group"]) {
    assert.throws(() => githubMainPromotion(event(), { ...github, GITHUB_EVENT_NAME: name }));
    assert.throws(() => gitlabMainPromotion({ ...gitlab, CI_PIPELINE_SOURCE: name }));
  }
});
test("GitLab allows normal development MRs but validates every main promotion", () => {
  assert.equal(gitlabMainPromotion(gitlab).allowed, true);
  assert.equal(gitlabMainPromotion({ ...gitlab, CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "fix/test", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev" }).applies, false);
  for (const key of Object.keys(gitlab)) { const value = { ...gitlab }; delete value[key]; assert.throws(() => gitlabMainPromotion(value)); }
});
test("generated workflow files and source CI contain the exact tested checks", async () => {
  const root = new URL("../", import.meta.url);
  assert.equal(await readFile(new URL(".github/workflows/main-source-policy.yml", root), "utf8"), githubPolicyWorkflow());
  assert.equal(await readFile(new URL(".gitlab/main-policy.yml", root), "utf8"), gitlabPolicyEntrypoint());
  assert.equal((await readFile(new URL(".gitlab-ci.yml", root), "utf8")).split(GITLAB_POLICY_MARKER + "\n")[1], gitlabPolicyJob());
});
test("GitHub metadata job is unconditional, read-only, unfiltered by paths and never checks out PR code", () => {
  const text = githubPolicyWorkflow();
  assert.match(text, /branches: \[main\]/u); assert.match(text, /permissions: \{\}/u);
  assert.ok(!/^\s*(?:if|paths|paths-ignore|continue-on-error):/mu.test(text));
  assert.ok(!text.includes("uses:") && !text.includes("secrets.") && !text.includes("workflow_dispatch:"));
  assert.ok(text.includes("GITHUB_EVENT_PATH") && text.includes("main-source-policy:"));
});
test("GitLab trusted root overlays the source config without checkout, inherited scripts or optional failure", () => {
  const text = gitlabPolicyEntrypoint();
  assert.match(text, /ref: '\$CI_COMMIT_SHA'/u); assert.match(text, /stage: \.pre/u);
  assert.match(text, /allow_failure: false/u); assert.match(text, /GIT_STRATEGY: none/u);
  assert.match(text, /before_script: \[\]/u); assert.match(text, /after_script: \[\]/u);
  assert.match(text, /default: false/u); assert.match(text, /variables: false/u);
});
test("embedded GitLab program actually exits nonzero for invalid sources without shell evaluation", () => {
  const program = gitlabPolicyJob().split("      node <<'RUNMESH_POLICY'\n")[1].split("      RUNMESH_POLICY")[0].replace(/^ {6}/gmu, "");
  const invoke = env => spawnSync(process.execPath, ["-e", program], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(invoke(gitlab).status, 0);
  const bad = invoke({ ...gitlab, CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "dev; echo bypass" });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /main_source_policy_denied/u);
});
test("both ordinary CI systems execute the generated-policy consistency check", async () => {
  for (const file of [".github/workflows/ci.yml", ".gitlab-ci.yml", "scripts/check-ci-parity.mjs"]) {
    assert.ok((await readFile(new URL("../" + file, import.meta.url), "utf8")).includes("npm run check:promotion-policy"));
  }
});

test("GitLab requires the documented MR project identity, not a nonexistent target alias", () => {
  assert.equal(gitlabMainPromotion(gitlab).allowed, true);
  const value = { ...gitlab, CI_MERGE_REQUEST_TARGET_PROJECT_ID: "123" };
  delete value.CI_MERGE_REQUEST_PROJECT_ID;
  assert.throws(() => gitlabMainPromotion(value));
});
