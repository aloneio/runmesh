import assert from "node:assert/strict";

/** Validate provider-returned identities, not a user-supplied success label.
 * The caller must retrieve these objects from the fixed provider endpoints. */
export function validateCrossforgeEvidence(expected, data) {
  assert.match(expected.sha, /^[a-f0-9]{40}$/u);
  assert.ok(["main", "dev"].includes(expected.branch));
  const gh = data.github, gl = data.gitlab;
  assert.equal(gh.repository?.full_name, "aloneio/runmesh");
  assert.equal(gh.head_sha, expected.sha); assert.equal(gh.head_branch, expected.branch);
  assert.equal(gh.event, "push"); assert.equal(gh.path, ".github/workflows/ci.yml");
  assert.equal(gh.status, "completed"); assert.equal(gh.conclusion, "success");
  assert.ok(Number.isSafeInteger(gh.id) && gh.id > 0 && Number.isSafeInteger(gh.run_attempt) && gh.run_attempt > 0);
  assert.ok(Array.isArray(data.githubJobs) && data.githubJobs.length > 0);
  const required = ["verify", "browser", "verify-all", "Runner native checks (ubuntu-latest)", "Runner native checks (windows-latest)", "Runner native checks (macos-latest)", "Runner LTS (22.23.2)", "Runner LTS (24.21.0)"];
  for (const name of required) {
    const jobs = data.githubJobs.filter(job => job.name === name);
    assert.equal(jobs.length, 1, `missing/ambiguous required GitHub job: ${name}`);
    const job = jobs[0];
    assert.equal(job.run_id, gh.id); assert.equal(job.head_sha, expected.sha);
    assert.equal(job.status, "completed"); assert.equal(job.conclusion, "success");
  }
  validateGitlabEvidence(expected, gl, data.gitlabJobs);
  return { schema_version: 1, evidence: "observed_provider_ci", commit: expected.sha, branch: expected.branch,
    github: { run_id: gh.id, attempt: gh.run_attempt, state: "passed" }, gitlab: { project_id: gl.project_id, pipeline_id: gl.id, state: "passed" },
    signed_release: "not_run", production: "not_run" };
}

/** Shared by stable cross-provider checks and the dev lane, whose GitHub
 * verification is a required reusable-workflow dependency of the same run. */
export function validateGitlabEvidence(expected, gl, jobs) {
  assert.match(expected.sha, /^[a-f0-9]{40}$/u); assert.ok(["main", "dev"].includes(expected.branch));
  assert.equal(gl.project_id, 85844627); assert.equal(gl.sha, expected.sha); assert.equal(gl.ref, expected.branch);
  assert.equal(gl.source, "push"); assert.equal(gl.status, "success");
  assert.ok(Number.isSafeInteger(gl.id) && gl.id > 0);
  assert.ok(Array.isArray(jobs));
  for (const name of ["verify", "browser"]) {
    const matches = jobs.filter(job => job.name === name);
    assert.equal(matches.length, 1, `missing/ambiguous required GitLab job: ${name}`);
    assert.equal(matches[0].status, "success"); assert.equal(matches[0].allow_failure, false);
    assert.equal(matches[0].pipeline?.id, gl.id); assert.equal(matches[0].commit?.id, expected.sha);
  }
  return { project_id: gl.project_id, pipeline_id: gl.id, commit: expected.sha, branch: expected.branch, state: "passed" };
}

export async function readProviderJson(url, headers, fetchImpl = fetch) {
  const target = new URL(url);
  assert.ok(["https://api.github.com", "https://gitlab.com"].includes(target.origin));
  assert.ok(!target.username && !target.password && target.protocol === "https:");
  const signal = AbortSignal.timeout(15000);
  const response = await fetchImpl(target, { headers: { accept: "application/json", ...headers }, redirect: "error", cache: "no-store", credentials: "omit", signal });
  if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw new Error("provider_evidence_unavailable"); }
  assert.ok(response.body); const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (let i = 0; ; i++) {
      assert.ok(i < 2048, "provider fragment limit");
      signal.throwIfAborted();
      const item = await reader.read(); signal.throwIfAborted(); if (item.done) break;
      bytes += item.value.byteLength; assert.ok(bytes <= 1048576, "provider response byte limit"); chunks.push(item.value);
    }
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
