import assert from "node:assert/strict";
import { writeSupplement } from "./ci-supplement.mjs";
import { readProviderJson, validateCrossforgeEvidence } from "./crossforge-evidence.mjs";
import { gateEvidence, sourceObservation, writeGateReport } from "./ci-report.mjs";

const source = sourceObservation(), started = Date.now(); let code = 1;
await writeGateReport(gateEvidence("crossforge_release", "running", 0, null, source));
await writeSupplement("crossforge-evidence", { schema_version: 1, state: "not_run", source });
try {
  assert.equal(process.argv.length, 2); assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.GITHUB_REPOSITORY, "aloneio/runmesh");
  assert.equal(source.state, "clean"); assert.equal(process.env.GITHUB_SHA, source.commit);
  const ghHeaders = process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {};
  const glHeaders = process.env.GITLAB_READ_API_TOKEN ? { "PRIVATE-TOKEN": process.env.GITLAB_READ_API_TOKEN } : {};
  const gh = path => readProviderJson(`https://api.github.com/repos/aloneio/runmesh/${path}`, ghHeaders);
  const gl = path => readProviderJson(`https://gitlab.com/api/v4/projects/85844627/${path}`, glHeaders);
  const expected = { sha: source.commit, branch: "main" };
  const [runs, pipelines, ghMain, glMain] = await Promise.all([
    gh(`actions/workflows/ci.yml/runs?head_sha=${expected.sha}&branch=main&event=push&per_page=2`),
    gl(`pipelines?sha=${expected.sha}&ref=main&source=push&order_by=id&sort=desc&per_page=2`),
    gh("branches/main"), gl("repository/branches/main"),
  ]);
  assert.equal(ghMain.commit?.sha, expected.sha); assert.equal(glMain.commit?.id, expected.sha);
  assert.equal(ghMain.protected, true); assert.equal(glMain.protected, true);
  assert.ok(runs.workflow_runs?.length > 0 && pipelines.length > 0, "exact commit CI has not completed on both providers");
  const run = runs.workflow_runs[0], pipeline = pipelines[0];
  assert.ok(Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt) && Number.isSafeInteger(pipeline.id));
  const [github, githubJobPage, gitlab, gitlabJobs] = await Promise.all([
    gh(`actions/runs/${run.id}`), gh(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`),
    gl(`pipelines/${pipeline.id}`), gl(`pipelines/${pipeline.id}/jobs?include_retried=false&per_page=100`),
  ]);
  assert.equal(githubJobPage.total_count, githubJobPage.jobs.length, "truncated GitHub jobs");
  assert.ok(gitlabJobs.length < 100, "ambiguous truncated GitLab jobs");
  const report = validateCrossforgeEvidence(expected, { github, githubJobs: githubJobPage.jobs, gitlab, gitlabJobs });
  await writeSupplement("crossforge-evidence", report);
  console.log(JSON.stringify(report)); code = 0;
} catch { console.error("crossforge_ci_unverified: no signing or publishing is allowed without exact-source successful checks on both providers; no polling/retry performed"); }
await writeGateReport(gateEvidence("crossforge_release", code === 0 ? "passed" : "failed", Date.now() - started, code, source));
process.exitCode = code;
