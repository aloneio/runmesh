import assert from "node:assert/strict";

const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

/** Counters only: never export test names, errors, stack traces or paths.
 * An exit code alone is not evidence that any required test actually ran.
 */
export function summarizeVitest(result, exitCode) {
  assert.equal(exitCode, 0, "test process failed");
  assert.equal(result?.success, true, "test reporter did not succeed");
  assert.equal(result.numFailedTestSuites, 0, "suite setup/teardown failed");
  assert.ok(Array.isArray(result.testResults) && result.testResults.length > 0 && result.testResults.length <= 256, "missing/bounded test files required");
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 }; let total = 0;
  for (const file of result.testResults) {
    assert.ok(Array.isArray(file.assertionResults), "missing test observations");
    assert.ok(file.status === "passed" || file.status === "skipped", "test file failed or did not complete");
    for (const item of file.assertionResults) {
      assert.ok(++total <= 10000, "test observation budget exceeded");
      const state = { passed: "passed", failed: "failed", pending: "skipped", skipped: "skipped", todo: "todo" }[item.status];
      assert.ok(state, "unknown/incomplete test result"); counts[state]++;
    }
  }
  assert.ok(counts.passed > 0 && counts.failed === 0, "no passing tests or an actual failure");
  assert.equal(result.numTotalTests, total, "inconsistent total test count");
  assert.equal(result.numPassedTests, counts.passed, "inconsistent passed count");
  assert.equal(result.numFailedTests, counts.failed, "inconsistent failed count");
  assert.equal(result.numPendingTests, counts.skipped, "inconsistent skipped count");
  if (result.numTodoTests !== undefined) assert.equal(result.numTodoTests, counts.todo, "inconsistent todo count");
  return { state: "passed", total, ...counts, files: result.testResults.length };
}

export function packageEvidence({ tests, source, artifact, platform, arch, node, elapsedMs }) {
  assert.equal(tests.state, "passed");
  assert.ok([tests.total, tests.passed, tests.failed, tests.skipped, tests.todo, tests.files].every(integer));
  assert.ok(tests.passed > 0 && tests.failed === 0 && tests.files > 0);
  assert.equal(tests.total, tests.passed + tests.failed + tests.skipped + tests.todo);
  assert.ok(artifact && hash(artifact.sha256) && integer(artifact.bytes) && artifact.bytes > 0);
  assert.ok(source && /^[a-f0-9]{40}$/u.test(source.commit) && /^[a-f0-9]{40}$/u.test(source.tree));
  assert.ok(["clean", "dirty"].includes(source.state));
  assert.ok(["linux", "darwin", "win32"].includes(platform));
  assert.ok(/^[A-Za-z0-9_-]{1,20}$/u.test(arch) && /^v[0-9.]+$/u.test(node)); assert.ok(integer(elapsedMs));
  return { schema_version: 1, evidence: "local_packaged_runner_e2e", attestation: "self_reported",
    source: { commit: source.commit, tree: source.tree, state: source.state },
    artifact: { sha256: artifact.sha256, bytes: artifact.bytes, signed: false, published: false },
    runtime: { platform, arch, node }, elapsed_ms: elapsedMs,
    tests: { state: "passed", total: tests.total, passed: tests.passed, failed: tests.failed, skipped: tests.skipped, todo: tests.todo, files: tests.files },
    signed_release: { state: "not_run" }, production: { state: "not_run" }, account_quotas: { state: "not_run" }, host_catalog: { state: "not_run" } };
}
