import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateCrossforgeEvidence, readProviderJson } from "../scripts/crossforge-evidence.mjs";
import { assertSecurityReadiness, REQUIRED_SECURITY_FINDINGS } from "../scripts/release-readiness.mjs";
import { initializeSourceCheckout } from "./helpers/source-checkout.mjs";

const sha = "a".repeat(40), expected = { sha, branch: "main" };
function fixture(sha = expected.sha) {
  const names = ["verify", "browser", "verify-all", "Runner native checks (ubuntu-latest)", "Runner native checks (windows-latest)", "Runner native checks (macos-latest)", "Runner LTS (22.23.2)", "Runner LTS (24.21.0)"];
  return { github: { id: 100, run_attempt: 1, repository: { full_name: "aloneio/runmesh" }, head_sha: sha, head_branch: "main", event: "push", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success" },
    githubJobs: names.map(name => ({ name, run_id: 100, run_attempt: 1, head_sha: sha, status: "completed", conclusion: "success" })),
    gitlab: { id: 200, project_id: 85844627, sha, ref: "main", source: "push", status: "success" },
    gitlabJobs: ["verify", "browser"].map(name => ({ name, status: "success", allow_failure: false, pipeline: { id: 200 }, commit: { id: sha } })) };
}
test("CI07 binds both provider runs and every required job to the candidate", () => {
  const result = validateCrossforgeEvidence(expected, fixture());
  assert.equal(result.commit, sha); assert.equal(result.gitlab.pipeline_id, 200);
  assert.equal(result.signed_release, "not_run");
});
test("CI07 accepts a complete rerun with a consistent attempt identity", () => {
  const f = fixture(); f.github.run_attempt = 2;
  for (const job of f.githubJobs) job.run_attempt = 2;
  assert.equal(validateCrossforgeEvidence(expected, f).github.attempt, 2);
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
  "successful job from an earlier attempt": f => f.github.run_attempt = 2,
  "successful job from a later attempt": f => f.githubJobs[0].run_attempt = 2,
  "job without an attempt identity": f => delete f.githubJobs[0].run_attempt,
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
for (const mode of ["stable", "rerun", "source_changed"]) test(`CI07 actual CLI pins provider attempt and checks source after reads: ${mode}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "runmesh-crossforge-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  await mkdir(join(directory, "scripts"));
  for (const file of ["check-crossforge-ci.mjs", "crossforge-evidence.mjs", "ci-contract.mjs", "ci-report.mjs", "source-git.mjs", "ci-supplement.mjs", "evidence-io.mjs"])
    await copyFile(new URL(`../scripts/${file}`, import.meta.url), join(directory, "scripts", file));
  const preload = join(directory, "provider-fixture.mjs");
  await writeFile(preload, `
    import assert from 'node:assert/strict';
    import { writeFile } from 'node:fs/promises';
    import { setImmediate } from 'node:timers/promises';
    const f = JSON.parse(process.env.CROSSFORGE_FIXTURE_DATA), sha = f.github.head_sha;
    const gh = 'https://api.github.com/repos/aloneio/runmesh/';
    const gl = 'https://gitlab.com/api/v4/projects/85844627/';
    const jobs = gl + 'pipelines/200/jobs?include_retried=false&per_page=100';
    const responses = new Map([
      [gh + 'actions/workflows/ci.yml/runs?head_sha=' + sha + '&branch=main&event=push&per_page=2', { workflow_runs: [f.github] }],
      [gl + 'pipelines?sha=' + sha + '&ref=main&source=push&order_by=id&sort=desc&per_page=2', [f.gitlab]],
      [gh + 'branches/main', { commit: { sha }, protected: true }],
      [gl + 'repository/branches/main', { commit: { id: sha }, protected: true }],
      [gh + 'actions/runs/100/attempts/' + f.github.run_attempt, f.github],
      [gh + 'actions/runs/100/attempts/' + f.github.run_attempt + '/jobs?per_page=100', { total_count: f.githubJobs.length, jobs: f.githubJobs }],
      [gl + 'pipelines/200', f.gitlab], [jobs, f.gitlabJobs],
    ]);
    // Replace only provider I/O; source observation and evidence publication stay real.
    globalThis.fetch = async (url, options) => {
      assert.ok(responses.has(url.href), 'unexpected fixture provider request');
      assert.deepEqual(options.headers, { accept: 'application/json' });
      await setImmediate();
      if (url.href === jobs && process.env.CROSSFORGE_FIXTURE_MODE === 'source_changed')
        await writeFile('source.txt', 'changed source\\n');
      return Response.json(responses.get(url.href));
    };
  `);
  const { source } = await initializeSourceCheckout(directory);
  const data = fixture(source.commit);
  if (mode === "rerun") {
    data.github.run_attempt = 2;
    for (const job of data.githubJobs) job.run_attempt = 2;
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|GITHUB_|GH_|GITLAB_|NODE_OPTIONS$)/iu.test(key)));
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, join(directory, "scripts/check-crossforge-ci.mjs")], {
    cwd: directory, env: { ...env, GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "aloneio/runmesh", GITHUB_SHA: source.commit,
      CROSSFORGE_FIXTURE_MODE: mode, CROSSFORGE_FIXTURE_DATA: JSON.stringify(data) },
    encoding: "utf8", timeout: 20000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  const gate = JSON.parse(await readFile(join(directory, "ci-results/crossforge_release.json"), "utf8"));
  const supplement = JSON.parse(await readFile(join(directory, "ci-results/crossforge-evidence.json"), "utf8"));
  assert.deepEqual(gate.source, source);
  const changed = mode === "source_changed";
  assert.equal(await readFile(join(directory, "source.txt"), "utf8"), changed ? "changed source\n" : "initial source\n");
  assert.deepEqual({ exit: result.status, gate: gate.state, supplement: supplement.evidence ?? supplement.state },
    changed ? { exit: 1, gate: "failed", supplement: "not_run" } : { exit: 0, gate: "passed", supplement: "observed_provider_ci" }, result.stderr);
  if (changed) {
    assert.deepEqual(supplement, { schema_version: 1, state: "not_run", source });
    assert.equal(result.stdout, ""); assert.match(result.stderr, /crossforge_ci_unverified/u);
  } else {
    assert.equal(supplement.commit, source.commit); assert.equal(supplement.github.state, "passed"); assert.equal(supplement.gitlab.state, "passed");
    assert.equal(supplement.github.attempt, data.github.run_attempt);
    assert.deepEqual(JSON.parse(result.stdout), supplement);
  }
});
function securityFixture() {
  const findings = REQUIRED_SECURITY_FINDINGS.map(id => ({ id, state: "closed", fixed_commit: "b".repeat(40), regressions: ["apps/worker/test/permission-chain.test.ts"] }));
  return { manifest: { schema_version: 1, findings }, evidence: { schema_version: 1, commit: sha, findings: findings.map(f => ({ id: f.id, state: "passed", passed: 1, failed: 0, skipped: 0, files: f.regressions })) } };
}
test("CI03 security closure uses current runtime evidence, not a self-referential tracked SHA", () => {
  const f = securityFixture(); assert.equal(assertSecurityReadiness(f.manifest, sha, f.evidence).findings, REQUIRED_SECURITY_FINDINGS.length);
  for (const mutate of [x => x.manifest.findings[0].state = "open", x => x.evidence.commit = "c".repeat(40), x => x.evidence.findings.pop(), x => x.evidence.findings[0].skipped = 1, x => x.evidence.findings[0].passed = 0, x => x.evidence.findings[0].files = [], x => x.manifest.findings[0].regressions = ["test/e2e/../../private.test.ts"]]) {
    const changed = securityFixture(); mutate(changed); assert.throws(() => assertSecurityReadiness(changed.manifest, sha, changed.evidence));
  }
  for (const index of [10, 11, 12, 13, 14, 15, 16, 17]) {
    const replaced = securityFixture();
    replaced.manifest.findings[index].id = "SEC99"; replaced.evidence.findings[index].id = "SEC99";
    assert.throws(() => assertSecurityReadiness(replaced.manifest, sha, replaced.evidence));
  }
});
