import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { readBoundedEvidenceFile, readEvidenceJson } from "../scripts/evidence-io.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ar08-package-wrapper-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  await mkdir(join(directory, "scripts"));
  for (const file of ["run-package-e2e.mjs", "test-evidence.mjs", "evidence-io.mjs"]) await writeFile(join(directory, "scripts", file), await readFile(join(root, "scripts", file)));
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
    const json = JSON.stringify(result);
    const start = json.indexOf('synthetic');
    const bytes = mode === 'invalid_utf8_report'
      ? Buffer.concat([Buffer.from(json.slice(0, start)), Buffer.from([255]), Buffer.from(json.slice(start + 1))])
      : Buffer.from(json);
    writeFileSync(process.env.RUNMESH_TEST_RESULT_PATH, bytes);
  `);
  // Instrument only this isolated subprocess's public filesystem boundary.
  // Swap/grow the real file after lstat has returned its original metadata.
  await writeFile(join(directory, "evidence-race-hook.mjs"), `
    import fs from 'node:fs';
    import { basename } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { execFileSync } from 'node:child_process';
    const original = fs.promises.lstat, originalOpen = fs.promises.open, seen = new Set();
    fs.promises.lstat = async (file, ...args) => {
      const info = await original(file, ...args);
      const name = basename(String(file)), mode = process.env.AR08_FIXTURE_MODE;
      const report = name === 'vitest.json', archive = name.endsWith('.tgz');
      if (!info.isFile() || seen.has(String(file))) return info;
      seen.add(String(file));
      if ((report && mode === 'report_growth_race') || (archive && mode === 'archive_growth_race')) {
        fs.appendFileSync(file, Buffer.alloc(8 * 1024 * 1024, 32));
      } else if (report && mode === 'report_fifo_race') {
        fs.unlinkSync(file); execFileSync('mkfifo', [String(file)]);
      } else if (report && mode === 'report_symlink_race') {
        fs.renameSync(file, String(file) + '.original');
        fs.symlinkSync(String(file) + '.original', file);
      }
      return info;
    };
    fs.promises.open = async (file, ...args) => {
      const handle = await originalOpen(file, ...args);
      if (basename(String(file)) !== 'vitest.json') return handle;
      const mode = process.env.AR08_FIXTURE_MODE;
      const stat = handle.stat.bind(handle), read = handle.read.bind(handle);
      let changed = false;
      handle.stat = async (...values) => {
        const info = await stat(...values);
        if (!changed && mode === 'report_descriptor_growth') {
          changed = true; fs.appendFileSync(file, Buffer.alloc(8 * 1024 * 1024, 32));
        }
        return info;
      };
      handle.read = async (...values) => {
        const result = await read(...values);
        if (!changed && result.bytesRead === 0 && mode === 'report_eof_growth') {
          changed = true; fs.appendFileSync(file, Buffer.alloc(8 * 1024 * 1024, 32));
        }
        return result;
      };
      return handle;
    };
    syncBuiltinESMExports();
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|CI_|GITHUB_|WORKERS_|RUNMESH_)/u.test(key)));
  const git = (...args) => execFileSync("git", ["-c", "user.name=aloneio", "-c", "user.email=git@aloneio.aleeas.com", ...args], { cwd: directory, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=dev"); git("add", "."); git("commit", "-m", "Synthetic package verification fixture");
  return { directory, invoke(mode = "success", extra = {}) {
    return spawnSync(process.execPath, ["--import", join(directory, "evidence-race-hook.mjs"), join(directory, "scripts/run-package-e2e.mjs")], {
      cwd: directory, env: { ...env, npm_execpath: join(directory, "npm-cli.js"), AR08_FIXTURE_MODE: mode, ...extra },
      encoding: "utf8", timeout: mode === "report_fifo_race" ? 3000 : 20000, maxBuffer: 1048576, windowsHide: true,
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
for (const mode of ["report_growth_race", "archive_growth_race", "invalid_utf8_report", "report_fifo_race", "report_symlink_race", "report_descriptor_growth", "report_eof_growth"]) {
  test(`release evidence rejects ${mode} without retaining success or waiting for a FIFO peer`, {
    skip: process.platform === "win32" && ["report_fifo_race", "report_symlink_race"].includes(mode),
  }, async t => {
    const f = await fixture(t), result = f.invoke(mode);
    assert.equal(result.error, undefined, "evidence rejection must not need the subprocess watchdog");
    assert.equal(result.status, 1, "malformed or changed evidence must fail the actual package wrapper");
    assert.equal((await f.report()).state, "failed");
    assert.ok(!result.stderr.includes(f.directory));
  });
}
test("evidence reader accepts exact UTF-8 byte limits and rejects invalid bounds, empty files and directories", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runmesh-evidence-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "report.json"), bytes = Buffer.from('{"message":"检查"}');
  await writeFile(file, bytes);
  assert.deepEqual(await readBoundedEvidenceFile(file, bytes.byteLength), bytes);
  assert.deepEqual(await readEvidenceJson(file, bytes.byteLength), { message: "检查" });
  await assert.rejects(readBoundedEvidenceFile(file, bytes.byteLength - 1));
  for (const limit of [0, -1, 1.5, NaN, Infinity, 8 * 1024 * 1024 + 1]) await assert.rejects(readBoundedEvidenceFile(file, limit));
  await assert.rejects(readBoundedEvidenceFile(directory));
  await writeFile(file, "");
  await assert.rejects(readBoundedEvidenceFile(file));
});
