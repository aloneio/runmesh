import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PRODUCTION_TRUST, requireProductionSource, checkProjectAndBranch,
  checkPipeline, checkMergedMr, checkGateArtifact } from "./production-approval-policy.mjs";

/** The release workstation holds the GitLab read credential, outside the
 * source tree. No token or synthetic approval file is accepted as proof. */
export function localGitLabClient() {
  function call(path) {
    assert.match(path, /^projects\/85844627(?:\/[a-zA-Z0-9/_?=&.%+-]+)?$/u);
    // glab authenticates with the release workstation's existing read session.
    // Errors are handled by the caller without exposing stderr or token values.
    const executable = process.platform === "win32" ? "glab.cmd" : "glab";
    return execFileSync(executable, ["api", path], {
      // Windows GitLab CLI installations may resolve through glab.cmd; the path
      // assertion above constrains every shell argument to the fixed API grammar.
      shell: process.platform === "win32",
      timeout: 14000, maxBuffer: 1024 * 1024, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return {
    json: async path => JSON.parse(call(path).toString("utf8")),
    artifact: async path => call(path),
  };
}

function newestMatching(items, predicate) {
  assert.ok(Array.isArray(items) && items.length > 0 && items.length <= 100, "missing or truncated pipeline list");
  const candidates = items.filter(predicate).sort((a, b) => b.id - a.id);
  assert.ok(candidates.length > 0, "required pipeline not found");
  return candidates[0];
}

/** Approval has no upload side effects. It re-reads current GitLab state on
 * every request, rather than accepting a saved success status or a branch's
 * most recent successful pipeline for another SHA. */
export async function verifyGitLabProductionApproval(source, client = localGitLabClient()) {
  requireProductionSource(source);
  const trust = PRODUCTION_TRUST;
  const root = `projects/${trust.projectId}`;
  const sha = source.commit;
  const [project, branch, branchRules] = await Promise.all([
    client.json(root), client.json(root + "/repository/branches/main"),
    client.json(root + "/protected_branches?per_page=100"),
  ]);
  checkProjectAndBranch(project, branch, branchRules, trust);
  assert.equal(branch.commit.id, sha, "remote main has moved");

  const pipelines = await client.json(root + `/pipelines?ref=main&sha=${sha}&per_page=100`);
  const selected = newestMatching(pipelines, p => p.sha === sha && p.ref === "main" && p.source === "push");
  const [mainPipeline, mainJobs] = await Promise.all([
    client.json(root + `/pipelines/${selected.id}`),
    client.json(root + `/pipelines/${selected.id}/jobs?per_page=100`),
  ]);
  const main = checkPipeline(mainPipeline, mainJobs, { sha, ref: "main", source: "push",
    projectId: trust.projectId, requiredJobs: trust.mainJobs });

  const related = await client.json(root + `/repository/commits/${sha}/merge_requests`);
  assert.ok(Array.isArray(related) && related.length <= 100);
  const merged = related.filter(mr => mr.state === "merged" && mr.source_branch === "dev"
    && mr.target_branch === "main" && mr.sha === sha && mr.source_project_id === trust.projectId
    && mr.target_project_id === trust.projectId).sort((a, b) => b.iid - a.iid);
  assert.ok(merged.length > 0, "no reviewed same-project dev-to-main MR");
  const mr = merged[0];
  const iid = checkMergedMr(mr, sha, trust);
  const mrPipelines = await client.json(root + `/merge_requests/${iid}/pipelines?per_page=100`);
  const chosen = newestMatching(mrPipelines, p => p.sha === sha
    && p.ref === `refs/merge-requests/${iid}/head` && p.source === "merge_request_event");
  const [mrPipeline, mrJobs] = await Promise.all([
    client.json(root + `/pipelines/${chosen.id}`),
    client.json(root + `/pipelines/${chosen.id}/jobs?per_page=100`),
  ]);
  const merge = checkPipeline(mrPipeline, mrJobs, { sha, ref: `refs/merge-requests/${iid}/head`,
    source: "merge_request_event", projectId: trust.projectId, requiredJobs: trust.mrJobs });

  const artifacts = [];
  for (const item of trust.requiredArtifacts) {
    const job = main[item.job];
    const bytes = await client.artifact(root + `/jobs/${job.id}/artifacts/${item.file}`);
    artifacts.push({ gate: item.gate, job_id: job.id,
      sha256: checkGateArtifact(bytes, item.gate, source) });
  }
  return Object.freeze({
    schema_version: 1, state: "approved", project_id: trust.projectId,
    commit: sha, tree: source.tree, main_pipeline_id: mainPipeline.id,
    mr_pipeline_id: mrPipeline.id, mr_iid: iid,
    jobs: { main: Object.fromEntries(Object.entries(main).map(([k, v]) => [k, v.id])),
      mr: Object.fromEntries(Object.entries(merge).map(([k, v]) => [k, v.id])) },
    artifacts,
  });
}
