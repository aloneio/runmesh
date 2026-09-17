import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCrossforgeEvidence, readProviderJson } from "../scripts/crossforge-evidence.mjs";
import { assertSecurityReadiness } from "../scripts/release-readiness.mjs";

const sha = "a".repeat(40), expected = { sha, branch: "main" };
function fixture() {
  const names = ["verify", "browser", "verify-all", "Runner native checks (ubuntu-latest)", "Runner native checks (windows-latest)", "Runner native checks (macos-latest)", "Runner LTS (22.23.2)", "Runner LTS (24.21.0)"];
  return { github: { id: 100, run_attempt: 1, repository: { full_name: "aloneio/runmesh" }, head_sha: sha, head_branch: "main", event: "push", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success" },
    githubJobs: names.map(name => ({ name, run_id: 100, head_sha: sha, status: "completed", conclusion: "success" })),
    gitlab: { id: 200, project_id: 85844627, sha, ref: "main", source: "push", status: "success" },
    gitlabJobs: ["verify", "browser"].map(name => ({ name, status: "success", allow_failure: false, pipeline: { id: 200 }, commit: { id: sha } })) };
}
test("CI07 binds both provider runs and every required job to the candidate", () => {
  const result = validateCrossforgeEvidence(expected, fixture());
  assert.equal(result.commit, sha); assert.equal(result.gitlab.pipeline_id, 200);
  assert.equal(result.signed_release, "not_run");
});
for (const [name, mutate] of Object.entries({
  "different GitHub commit": f => f.github.head_sha = "b".repeat(40),
  "different GitLab commit": f => f.gitlab.sha = "b".repeat(40),
  "fork repository": f => f.github.repository.full_name = "other/runmesh",
  "wrong GitLab project": f => f.gitlab.project_id = 1,
  "dev instead of main": f => f.github.head_branch = "dev",
  "MR pipeline instead of protected push": f => f.gitlab.source = "merge_request_event",
  "wrong workflow": f => f.github.path = ".github/workflows/unrelated.yml",
  "pending run": f => f.github.status = "in_progress",
  "cancelled run": f => f.github.conclusion = "cancelled",
  "allowed GitLab job failure": f => f.gitlabJobs[0].allow_failure = true,
  "missing native lane": f => f.githubJobs.pop(),
  "duplicate required job": f => f.githubJobs.push(f.githubJobs[0]),
  "successful job from another run": f => f.githubJobs[0].run_id = 99,
  "job from another commit": f => f.gitlabJobs[0].commit.id = "b".repeat(40),
  "skipped browser": f => f.githubJobs.find(j => j.name === "browser").conclusion = "skipped",
  "failed GitLab pipeline": f => f.gitlab.status = "failed",
})) test(`CI07 refuses ${name}`, () => { const f = fixture(); validateCrossforgeEvidence(expected, f); mutate(f); assert.throws(() => validateCrossforgeEvidence(expected, f)); });
test("CI07 provider requests are bounded, omit browser credentials and never retry", async () => {
  let calls = 0;
  const response = await readProviderJson("https://api.github.com/repos/aloneio/runmesh", {}, async (url, options) => {
    calls++; assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit"); return Response.json({ ok: true });
  });
  assert.deepEqual(response, { ok: true }); assert.equal(calls, 1);
  for (const status of [302, 401, 403, 404, 429, 500]) await assert.rejects(readProviderJson("https://gitlab.com/api/v4/projects/85844627", {}, async () => new Response("private error", { status })));
  await assert.rejects(readProviderJson("https://attacker.invalid", {}, async () => { throw Error("must not fetch"); }));
  await assert.rejects(readProviderJson("https://api.github.com", {}, async () => new Response("x".repeat(1048577))));
});
test("CI07 stalled response cancellation uses the request deadline", async t => {
  const controller = new AbortController(); t.mock.method(AbortSignal, "timeout", () => controller.signal);
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const timeout = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(readProviderJson("https://api.github.com", {}, async () => response)); assert.equal(cancelled, true); }
  finally { clearTimeout(timeout); }
});
function securityFixture() {
  const findings = Array.from({ length: 13 }, (_, index) => ({ id: `SEC${String(index + 1).padStart(2, "0")}`, state: "closed", fixed_commit: "b".repeat(40), regressions: ["apps/worker/test/permission-chain.test.ts"] }));
  return { manifest: { schema_version: 1, findings }, evidence: { schema_version: 1, commit: sha, findings: findings.map(f => ({ id: f.id, state: "passed", passed: 1, failed: 0, skipped: 0, files: f.regressions })) } };
}
test("CI03 security closure uses current runtime evidence, not a self-referential tracked SHA", () => {
  const f = securityFixture(); assert.equal(assertSecurityReadiness(f.manifest, sha, f.evidence).findings, 13);
  for (const mutate of [x => x.manifest.findings[0].state = "open", x => x.evidence.commit = "c".repeat(40), x => x.evidence.findings.pop(), x => x.evidence.findings[0].skipped = 1, x => x.evidence.findings[0].passed = 0, x => x.evidence.findings[0].files = [], x => x.manifest.findings[0].regressions = ["test/e2e/../../private.test.ts"]]) {
    const changed = securityFixture(); mutate(changed); assert.throws(() => assertSecurityReadiness(changed.manifest, sha, changed.evidence));
  }
  for (const index of [10, 11, 12]) {
    const replaced = securityFixture();
    replaced.manifest.findings[index].id = "SEC14"; replaced.evidence.findings[index].id = "SEC14";
    assert.throws(() => assertSecurityReadiness(replaced.manifest, sha, replaced.evidence));
  }
});
