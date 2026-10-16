import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGateArtifact, checkPipeline, checkProjectAndBranch, PRODUCTION_TRUST } from "../scripts/production-approval-policy.mjs";
import { verifyGitLabProductionApproval } from "../scripts/production-approval-gitlab.mjs";

const sha = "a".repeat(40), tree = "b".repeat(40);
const source = { branch: "main", commit: sha, tree, state: "clean" };
const base = `projects/${PRODUCTION_TRUST.projectId}`;
const rules = [
  { name: "main", allow_force_push: false, push_access_levels: [{ access_level: 0 }],
    merge_access_levels: [{ access_level: 40 }] },
  { name: "dev", allow_force_push: false, push_access_levels: [{ access_level: 30 }],
    merge_access_levels: [{ access_level: 30 }] },
];
const project = { id: PRODUCTION_TRUST.projectId, path_with_namespace: PRODUCTION_TRUST.projectPath,
  default_branch: "main", merge_method: "ff", only_allow_merge_if_pipeline_succeeds: true,
  allow_merge_on_skipped_pipeline: false, ci_config_path: ".gitlab/main-policy.yml@aloneio/runmesh:main",
  ci_pipeline_variables_minimum_override_role: "no_one_allowed" };
function pipeline(id, ref, origin, status = "success") {
  return { id, ref, sha, source: origin, status, project_id: PRODUCTION_TRUST.projectId };
}
function job(id, name, p) {
  return { id, name, status: "success", allow_failure: false, retried: false,
    pipeline: { id: p.id, sha: p.sha } };
}
function gate(gateName, overrides = {}) {
  return Buffer.from(JSON.stringify({ schema_version: 1, evidence: "ci_gate_execution",
    gate: gateName, state: "passed", exit_code: 0,
    source: { commit: sha, tree, state: "clean" }, ...overrides }) + "\n");
}
function fixture(change = () => {}) {
  const main = pipeline(101, "main", "push");
  const mr = pipeline(102, "refs/merge-requests/86/head", "merge_request_event");
  const mainJobs = PRODUCTION_TRUST.mainJobs.map((name, i) => job(i + 1, name, main));
  const mrJobs = PRODUCTION_TRUST.mrJobs.map((name, i) => job(i + 4, name, mr));
  const records = new Map([
    [base, structuredClone(project)],
    [base + "/repository/branches/main", { name: "main", protected: true, commit: { id: sha } }],
    [base + "/protected_branches?per_page=100", structuredClone(rules)],
    [base + `/pipelines?ref=main&sha=${sha}&per_page=100`, [main]],
    [base + "/pipelines/101", main],
    [base + "/pipelines/101/jobs?per_page=100", mainJobs],
    [base + `/repository/commits/${sha}/merge_requests`, [
      { iid: 86, sha, source_branch: "dev", target_branch: "main",
        source_project_id: PRODUCTION_TRUST.projectId, target_project_id: PRODUCTION_TRUST.projectId,
        state: "merged", merged_at: "2026-10-16T10:43:50Z", squash: false },
    ]],
    [base + "/merge_requests/86/pipelines?per_page=100", [mr]],
    [base + "/pipelines/102", mr],
    [base + "/pipelines/102/jobs?per_page=100", mrJobs],
    [base + "/jobs/2/artifacts/ci-results/unit.json", gate("unit")],
    [base + "/jobs/2/artifacts/ci-results/installed_transport.json", gate("installed_transport")],
    [base + "/jobs/3/artifacts/ci-results/browser.json", gate("browser")],
  ]);
  change(records);
  return {
    json: async path => {
      if (!records.has(path)) throw Error("unexpected GitLab endpoint");
      return structuredClone(records.get(path));
    },
    artifact: async path => {
      const value = records.get(path);
      if (!Buffer.isBuffer(value)) throw Error("artifact missing");
      return Buffer.from(value);
    },
  };
}

test("exact-SHA main and MR gates plus clean artifacts are required before upload", async () => {
  const approval = await verifyGitLabProductionApproval(source, fixture());
  assert.equal(approval.commit, sha);
  assert.equal(approval.tree, tree);
  assert.equal(approval.main_pipeline_id, 101);
  assert.equal(approval.mr_pipeline_id, 102);
  assert.deepEqual(approval.artifacts.map(x => x.gate), ["unit", "installed_transport", "browser"]);
  for (const proof of approval.artifacts) assert.match(proof.sha256, /^[0-9a-f]{64}$/u);
});

test("deny missing, failed, running, old-SHA or weak GitLab policy and branch state", async () => {
  const mainPath = base + "/pipelines/101";
  const listPath = base + `/pipelines?ref=main&sha=${sha}&per_page=100`;
  const mrPath = base + "/pipelines/102";
  const jobsPath = base + "/pipelines/101/jobs?per_page=100";
  const mrJobs = base + "/pipelines/102/jobs?per_page=100";
  const cases = [
    r => { r.get(mainPath).status = "running"; },
    r => { r.get(mainPath).status = "failed"; },
    r => { r.get(mainPath).ref = "dev"; },
    r => { r.get(mainPath).source = "web"; },
    r => { r.get(mainPath).sha = "c".repeat(40); },
    r => { r.get(mainPath).project_id = 999; },
    r => { r.get(listPath)[0].sha = "c".repeat(40); },
    r => { r.get(jobsPath)[1].status = "skipped"; },
    r => { r.get(jobsPath)[1].allow_failure = true; },
    r => { r.get(jobsPath).splice(1, 1); },
    r => { r.get(mrPath).status = "running"; },
    r => { r.get(mrJobs)[0].status = "failed"; },
    r => { r.get(base + "/repository/branches/main").commit.id = "c".repeat(40); },
    r => { r.get(base + "/protected_branches?per_page=100")[0].allow_force_push = true; },
    r => { r.get(base + "/protected_branches?per_page=100")[0].push_access_levels = [{ access_level: 30 }]; },
    r => { r.get(base).ci_config_path = ".gitlab/main-policy.yml@aloneio/runmesh:dev"; },
    r => { r.get(base).only_allow_merge_if_pipeline_succeeds = false; },
    r => { r.get(base + `/repository/commits/${sha}/merge_requests`)[0].source_branch = "feature"; },
  ];
  for (const mutation of cases) {
    await assert.rejects(verifyGitLabProductionApproval(source, fixture(mutation)));
  }
  for (const variant of [{ ...source, branch: "dev" }, { ...source, state: "dirty" },
    { ...source, commit: "c".repeat(40) }, { ...source, tree: "" }]) {
    await assert.rejects(verifyGitLabProductionApproval(variant, fixture()));
  }
});

test("deny forged or misplaced CI artifacts and detect stale pipeline reruns", async () => {
  const artifactPath = base + "/jobs/2/artifacts/ci-results/unit.json";
  for (const rewrite of [() => Buffer.alloc(0),
    () => gate("unit", { state: "running" }),
    () => gate("unit", { source: { commit: "c".repeat(40), tree, state: "clean" } }),
    () => gate("unit", { source: { commit: sha, tree: "c".repeat(40), state: "clean" } })]) {
    await assert.rejects(verifyGitLabProductionApproval(source, fixture(r => r.set(artifactPath, rewrite()))));
  }
  await assert.rejects(verifyGitLabProductionApproval(source, fixture(r => {
    const p = r.get(base + `/pipelines?ref=main&sha=${sha}&per_page=100`)[0];
    r.set(base + `/pipelines?ref=main&sha=${sha}&per_page=100`, [p, { ...p, id: 202, status: "running" }]);
  })));
  assert.throws(() => checkGateArtifact(gate("browser"), "unit", source));
});

test("reject ambiguous, optional and unverified required job records", () => {
  const p = pipeline(4, "main", "push");
  const j = PRODUCTION_TRUST.mainJobs.map((name, i) => job(i + 11, name, p));
  const args = { sha, ref: "main", source: "push", projectId: PRODUCTION_TRUST.projectId, requiredJobs: PRODUCTION_TRUST.mainJobs };
  assert.equal(checkPipeline(p, j, args).verify.id, 12);
  assert.throws(() => checkPipeline(p, [...j, structuredClone(j[0])], args));
  assert.throws(() => checkPipeline(p, j.map(x => ({ ...x, allow_failure: true })), args));
  assert.throws(() => checkProjectAndBranch(project, { name: "main", protected: true, commit: { id: sha } },
    [...structuredClone(rules), { name: "*", allow_force_push: true }]));
});
