import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ar08-package-wrapper-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  await mkdir(join(directory, "scripts"));
  for (const file of ["run-package-e2e.mjs", "test-evidence.mjs"]) await writeFile(join(directory, "scripts", file), await readFile(join(root, "scripts", file)));
  await writeFile(join(directory, "package.json"), '{"name":"synthetic-test","version":"1.0.0","private":true}\n');
  await writeFile(join(directory, ".gitignore"), '.verification/\n');
  await writeFile(join(directory, "source.txt"), "original\n");
  await writeFile(join(directory, "npm-cli.js"), `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2), target = args[args.indexOf('--pack-destination') + 1];
    fs.writeFileSync(path.join(target, 'synthetic-1.0.0.tgz'), 'synthetic archive, never installed');
    console.log('lifecycle output precedes JSON'); console.log('[{"filename":"synthetic-1.0.0.tgz"}]');
  `);
  await writeFile(join(directory, "scripts/test-packed-runner.mjs"), `
    import { writeFileSync } from 'node:fs';
    const mode = process.env.AR08_FIXTURE_MODE;
    if (mode === 'exit_failure') process.exit(4);
    if (mode === 'missing_report') process.exit(0);
    if (mode === 'artifact_changed') writeFileSync(process.argv[2], 'changed');
    if (mode === 'source_changed') writeFileSync('source.txt', 'changed');
    const result = { success: true, numFailedTestSuites: 0, numTotalTests: 2,
      numPassedTests: 1, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0,
      testResults: [{ status: 'passed', name: '/private/path', assertionResults: [
        { status: 'passed', fullName: 'synthetic', failureMessages: ['private-text'] }, { status: 'pending' } ] }] };
    if (mode === 'bad_counts') result.numTotalTests++;
    writeFileSync(process.env.RUNMESH_TEST_RESULT_PATH, JSON.stringify(result));
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|CI_|GITHUB_|WORKERS_|RUNMESH_)/u.test(key)));
  const git = (...args) => execFileSync("git", ["-c", "user.name=aloneio", "-c", "user.email=git@aloneio.aleeas.com", ...args], { cwd: directory, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=dev"); git("add", "."); git("commit", "-m", "Synthetic package verification fixture");
  return { directory, invoke(mode = "success", extra = {}) {
    return spawnSync(process.execPath, [join(directory, "scripts/run-package-e2e.mjs")], {
      cwd: directory, env: { ...env, npm_execpath: join(directory, "npm-cli.js"), AR08_FIXTURE_MODE: mode, ...extra },
      encoding: "utf8", timeout: 20000, maxBuffer: 1048576, windowsHide: true,
    });
  }, async report() { return JSON.parse(await readFile(join(directory, ".verification/package-e2e.json"), "utf8")); } };
}

test("AR08 actual wrapper tolerates lifecycle text and emits only verified counters", async t => {
  const f = await fixture(t), result = f.invoke();
  assert.equal(result.status, 0, result.stderr);
  const report = await f.report();
  assert.equal(report.source.state, "clean"); assert.equal(report.tests.passed, 1); assert.equal(report.tests.skipped, 1);
  assert.equal(report.production.state, "not_run"); assert.ok(!JSON.stringify(report).includes("private"));
});
test("AR08 failed rerun replaces previous success instead of leaving stale evidence", async t => {
  const f = await fixture(t); assert.equal(f.invoke().status, 0);
  assert.notEqual(f.invoke("exit_failure").status, 0);
  assert.deepEqual(await f.report(), { schema_version: 1, evidence: "local_packaged_runner_e2e", state: "failed", phase: "installed_package_e2e" });
});
for (const mode of ["missing_report", "bad_counts", "artifact_changed", "source_changed"]) {
  test(`AR08 actual wrapper rejects ${mode}`, async t => {
    const f = await fixture(t), result = f.invoke(mode);
    assert.notEqual(result.status, 0); assert.equal((await f.report()).state, "failed");
    assert.ok(!result.stderr.includes(f.directory));
  });
}
test("AR08 actual wrapper rejects an unrelated CI source before packing", async t => {
  const f = await fixture(t), result = f.invoke("success", { GITHUB_SHA: "a".repeat(40) });
  assert.notEqual(result.status, 0); assert.equal((await f.report()).phase, "preflight");
});
