import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/** Trust configuration is reviewed source, not a mutable environment switch. */
export const PRODUCTION_TRUST = Object.freeze({
  projectId: 85844627,
  projectPath: "aloneio/runmesh",
  branch: "main",
  sourceBranch: "dev",
  inertBuildBranchRule: "runmesh-trusted-release-*",
  mainJobs: Object.freeze(["privacy-policy", "verify", "browser"]),
  mrJobs: Object.freeze(["main-source-policy", "privacy-policy", "verify", "browser"]),
  requiredArtifacts: Object.freeze([
    { job: "verify", gate: "unit", file: "ci-results/unit.json" },
    { job: "verify", gate: "installed_transport", file: "ci-results/installed_transport.json" },
    { job: "browser", gate: "browser", file: "ci-results/browser.json" },
  ]),
});
const sha40 = /^[0-9a-f]{40}$/u;
const sha64 = /^[0-9a-f]{64}$/u;

export function requireProductionSource(source) {
  assert.ok(source && source.state === "clean" && source.branch === "main", "unapproved production source");
  assert.match(source.commit ?? "", sha40, "invalid production commit");
  assert.match(source.tree ?? "", sha40, "invalid production tree");
  return source;
}

export function checkProjectAndBranch(project, branch, rules, trust = PRODUCTION_TRUST) {
  assert.equal(project?.id, trust.projectId, "different GitLab project");
  assert.equal(project?.path_with_namespace, trust.projectPath);
  assert.equal(project?.default_branch, trust.branch);
  assert.equal(project?.merge_method, "ff");
  assert.equal(project?.only_allow_merge_if_pipeline_succeeds, true);
  assert.equal(project?.allow_merge_on_skipped_pipeline, false);
  assert.equal(project?.ci_config_path, ".gitlab/main-policy.yml@aloneio/runmesh:main");
  assert.equal(project?.ci_pipeline_variables_minimum_override_role, "no_one_allowed");
  assert.equal(branch?.name, trust.branch);
  assert.equal(branch?.protected, true);
  assert.match(branch?.commit?.id ?? "", sha40);
  assert.ok(Array.isArray(rules), "protected branch rules missing");
  // GitLab uses the most permissive matching branch rule. The third, narrow
  // protection explicitly reserves the inert Cloudflare Builds trigger name;
  // otherwise a Developer could create that branch and run repository-supplied
  // code in a build context holding privileged Cloudflare credentials.
  assert.deepEqual(rules.map(rule => rule.name).sort(),
    [trust.branch, trust.sourceBranch, trust.inertBuildBranchRule].sort(),
    "unreviewed protected branch or wildcard rule");
  const exactMain = rules.find(x => x.name === trust.branch);
  const exactDev = rules.find(x => x.name === trust.sourceBranch);
  const inertBuildRule = rules.find(x => x.name === trust.inertBuildBranchRule);
  for (const rule of [exactMain, exactDev, inertBuildRule])
    assert.equal(rule?.allow_force_push, false, "force push must remain disabled");
  assert.deepEqual(exactMain.push_access_levels.map(x => x.access_level), [0]);
  assert.deepEqual(exactMain.merge_access_levels.map(x => x.access_level), [40]);
  assert.deepEqual(exactDev.push_access_levels.map(x => x.access_level), [30]);
  assert.deepEqual(inertBuildRule.push_access_levels.map(x => x.access_level), [0]);
  assert.deepEqual(inertBuildRule.merge_access_levels.map(x => x.access_level), [0]);
}

export function checkPipeline(pipeline, jobs, { sha, ref, source, projectId, requiredJobs }) {
  assert.match(sha, sha40);
  assert.equal(pipeline?.sha, sha, "pipeline belongs to a different commit");
  assert.equal(pipeline?.ref, ref, "pipeline ref mismatch");
  assert.equal(pipeline?.source, source, "pipeline trigger mismatch");
  assert.equal(pipeline?.project_id, projectId, "pipeline belongs to a different project");
  assert.equal(pipeline?.status, "success", "CI still incomplete or unsuccessful");
  assert.ok(Array.isArray(jobs) && jobs.length <= 100, "missing or truncated CI jobs");
  const selected = {};
  for (const name of requiredJobs) {
    const matches = jobs.filter(job => job.name === name && job.retried !== true);
    assert.equal(matches.length, 1, "required CI job missing or ambiguous: " + name);
    const job = matches[0];
    assert.equal(job.status, "success", "required CI job did not pass: " + name);
    assert.equal(job.allow_failure, false, "required CI job cannot be optional: " + name);
    assert.equal(job.pipeline?.sha ?? sha, sha);
    assert.equal(job.pipeline?.id ?? pipeline.id, pipeline.id);
    assert.ok(Number.isSafeInteger(job.id) && job.id > 0);
    selected[name] = job;
  }
  return selected;
}

export function checkMergedMr(mr, sha, trust = PRODUCTION_TRUST) {
  assert.ok(mr && mr.state === "merged", "a merged dev-to-main MR is required");
  assert.equal(mr.source_branch, trust.sourceBranch);
  assert.equal(mr.target_branch, trust.branch);
  assert.equal(mr.source_project_id, trust.projectId);
  assert.equal(mr.target_project_id, trust.projectId);
  assert.equal(mr.sha, sha, "MR head does not match the candidate");
  assert.ok(typeof mr.merged_at === "string" && Number.isFinite(Date.parse(mr.merged_at)));
  assert.ok(Number.isSafeInteger(mr.iid) && mr.iid > 0);
  assert.ok(mr.squash !== true, "squashed MR changes the reviewed source identity");
  return mr.iid;
}

export function checkGateArtifact(bytes, gate, source) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.byteLength > 0 && bytes.byteLength <= 65536, "invalid CI artifact");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.match(digest, sha64);
  const evidence = JSON.parse(bytes.toString("utf8"));
  assert.equal(evidence.schema_version, 1);
  assert.equal(evidence.evidence, "ci_gate_execution");
  assert.equal(evidence.gate, gate);
  assert.equal(evidence.state, "passed");
  assert.equal(evidence.exit_code, 0);
  assert.equal(evidence.source?.state, "clean");
  assert.equal(evidence.source?.commit, source.commit, "artifact commit differs");
  assert.equal(evidence.source?.tree, source.tree, "artifact tree differs");
  return digest;
}
