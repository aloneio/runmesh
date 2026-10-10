import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { readBoundedEvidenceFile, readEvidenceJson } from "../scripts/evidence-io.mjs";
import { npmCliPath } from "../scripts/npm-cli.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function lookupWithoutSubprocesses(env, cwd) {
  const helper = new URL("../scripts/npm-cli.mjs", import.meta.url).href;
  // The lookup itself must own no descendants or temporary working directory.
  // Run the public helper in a fresh process so this guard cannot affect peers.
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.execFile = () => { throw new Error('npm discovery must not launch subprocesses'); };
    syncBuiltinESMExports();
    const { npmCliPath } = await import(${JSON.stringify(helper)});
    console.log(await npmCliPath());
  `], { cwd, env, encoding: "utf8", timeout: 10000, windowsHide: true });
}

function discoveryEnvironment(path) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path" && key !== "npm_execpath"));
  return { ...env, PATH: path };
}

test("package commands preserve CLI and archive paths containing spaces", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runmesh npm arguments "));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cli = join(directory, "npm-cli.js"), archive = join(directory, "runner archive.tgz");
  await writeFile(cli, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const selected = await npmCliPath({ ...process.env, npm_execpath: cli });
  const result = spawnSync(process.execPath, [selected, "install", "--offline", archive], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["install", "--offline", archive]);
});

test("direct Node package entrypoints locate the installed npm CLI offline independently of the caller project", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runmesh npm caller "));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(join(directory, "package.json"), '{"name":"synthetic-npm-caller","version":"1.0.0","private":true}\n');
  // Project script configuration must not participate in finding npm itself.
  await writeFile(join(directory, ".npmrc"), `script-shell=${join(directory, "missing-script-shell")}\n`);
  const env = { ...process.env }; delete env.npm_execpath;
  const lookup = lookupWithoutSubprocesses(env, directory);
  assert.equal(lookup.error, undefined, "npm discovery must finish within its own bound");
  assert.equal(lookup.status, 0, lookup.stderr);
  const cli = lookup.stdout.trim();
  const result = spawnSync(process.execPath, [cli, "--version"], { env, encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/u);
});

for (const layout of ["prefix", "package-bin"]) test(`npm discovery preserves the first PATH ${layout} installation without executing its launcher`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "runmesh npm identity "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, "first npm"), later = join(directory, "later npm");
  const relativeCli = layout === "prefix" ? ["node_modules", "npm", "bin", "npm-cli.js"] : ["npm-cli.js"];
  for (const entry of [first, later]) {
    await mkdir(join(entry, ...relativeCli.slice(0, -1)), { recursive: true });
    await writeFile(join(entry, ...relativeCli), "throw new Error('discovery must not execute the npm CLI');\n");
    await writeFile(join(entry, process.platform === "win32" ? "npm.cmd" : "npm"), "discovery must not execute the launcher\n", { mode: 0o755 });
  }
  const result = lookupWithoutSubprocesses(discoveryEnvironment([first, later].join(delimiter)), directory);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), await realpath(join(first, ...relativeCli)));
});

test("npm discovery rejects an unsupported first PATH launcher instead of selecting another installation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runmesh npm unsupported "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, "custom shim"), later = join(directory, "standard npm");
  await mkdir(first); await mkdir(join(later, "node_modules", "npm", "bin"), { recursive: true });
  for (const entry of [first, later]) await writeFile(join(entry, process.platform === "win32" ? "npm.cmd" : "npm"), "discovery must not execute the launcher\n", { mode: 0o755 });
  const cli = join(later, "node_modules", "npm", "bin", "npm-cli.js");
  await writeFile(cli, "// installed npm fixture\n");
  const env = discoveryEnvironment([first, later].join(delimiter));
  const result = lookupWithoutSubprocesses(env, directory);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /first npm launcher.*npm_execpath/u);
  assert.equal(await npmCliPath({ ...env, npm_execpath: cli }), cli);
  await assert.rejects(npmCliPath({ ...env, npm_execpath: "relative/npm-cli.js" }), /installed npm CLI/u);
});

test("npm discovery follows a POSIX launcher symlink to its installed CLI", { skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "runmesh npm symlink "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin"), packageBin = join(directory, "share", "nodejs", "npm", "bin");
  await mkdir(bin); await mkdir(packageBin, { recursive: true });
  const cli = join(packageBin, "npm-cli.js");
  await writeFile(cli, "throw new Error('discovery must not execute the npm CLI');\n", { mode: 0o755 });
  await symlink(cli, join(bin, "npm"));
  const result = lookupWithoutSubprocesses(discoveryEnvironment(bin), directory);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), await realpath(cli));
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ar08-package-wrapper-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  await mkdir(join(directory, "scripts"));
  for (const file of ["run-package-e2e.mjs", "test-evidence.mjs", "evidence-io.mjs", "ci-report.mjs", "source-git.mjs", "ci-supplement.mjs", "mcp-diagnostics.mjs", "ui-browser-contract.mjs", "ui-browser-diagnostics.mjs"]) await writeFile(join(directory, "scripts", file), await readFile(join(root, "scripts", file)));
  await writeFile(join(directory, "package.json"), '{"name":"synthetic-test","version":"1.0.0","private":true}\n');
  await writeFile(join(directory, ".gitignore"), '.verification/\nci-results/\n');
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
    console.log('private-stdout-credential'); console.error('private-stderr-credential');
    if (['test_failure', 'many_test_failures', 'suite_failure', 'test_failure_cleanup'].includes(mode)) {
      result.success = false; result.numFailedTestSuites = 1;
      const file = result.testResults[0];
      file.status = 'failed'; file.name = '/private-credential/test/e2e/mcp-runner.e2e.test.ts';
      file.message = 'Error: Hook timed out in 30000ms. private-suite-credential';
      if (mode !== 'suite_failure') {
        const count = mode === 'many_test_failures' ? 40 : 1;
        result.numTotalTests = count; result.numPassedTests = 0; result.numFailedTests = count; result.numPendingTests = 0;
        file.assertionResults = Array.from({ length: count }, () => ({
          status: 'failed', fullName: 'private-title-credential',
          failureMessages: ['AssertionError: private-assertion-credential /private/path'],
        }));
      }
      process.exitCode = 4;
    }
    if (mode === 'invalid_json_failure') {
      writeFileSync(process.env.RUNMESH_TEST_RESULT_PATH, '{private-json-credential');
      process.exit(4);
    }
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
    const original = fs.promises.lstat, originalOpen = fs.promises.open, originalRm = fs.promises.rm, seen = new Set();
    fs.promises.rm = async (file, ...args) => {
      const result = await originalRm(file, ...args);
      // Remove this fixture's data, then inject the terminal public I/O error.
      // The test owns no locked file or abandoned temporary directory.
      if (basename(String(file)).startsWith('runmesh-ar08-package-') && ['cleanup_failure', 'test_failure_cleanup'].includes(process.env.AR08_FIXTURE_MODE))
        throw Object.assign(new Error('PRIVATE_CLEANUP_PATH'), { code: 'EACCES' });
      return result;
    };
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
    // --import accepts an ESM specifier: drive-letter paths are not file URLs.
    const preload = pathToFileURL(join(directory, "evidence-race-hook.mjs")).href;
    return spawnSync(process.execPath, ["--import", preload, join(directory, "scripts/run-package-e2e.mjs")], {
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
  assert.deepEqual(await f.report(), { schema_version: 1, evidence: "local_packaged_runner_e2e", state: "failed", phase: "installed_package_e2e",
    diagnostics: { step: "test_process", kind: "process_exit", exit_code: 4, test_report: { state: "missing" } } });
});

for (const mode of ["cleanup_failure", "test_failure_cleanup"]) test(`AR08 ${mode} never leaves passed package evidence`, async t => {
  const f = await fixture(t);
  assert.equal(f.invoke().status, 0);
  const result = f.invoke(mode), report = await f.report();
  const archived = JSON.parse(await readFile(join(f.directory, "ci-results/package-e2e.json"), "utf8"));
  assert.equal(result.status, 1); assert.equal(result.error, undefined);
  assert.equal(report.state, "failed"); assert.equal(archived.state, "failed");
  assert.equal(report.phase, mode === "cleanup_failure" ? "cleanup" : "installed_package_e2e");
  assert.equal(report.diagnostics.step, mode === "cleanup_failure" ? "temporary_cleanup" : "test_process");
  assert.equal(report.diagnostics.kind, mode === "cleanup_failure" ? "permission_denied" : "process_exit");
  if (mode === "test_failure_cleanup") {
    assert.equal(report.diagnostics.exit_code, 4);
    assert.equal(report.diagnostics.test_report.failed_tests, 1);
  }
  assert.match(result.stderr, /"phase":"cleanup"/u);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_CLEANUP_PATH|private-stdout|private-stderr|AR08_PACKAGED_E2E_VERIFIED/u);
  assert.ok(!result.stderr.includes(f.directory));
});
test("AR08 failed package tests retain bounded locations and classes without copying credential-bearing reporter fields or logs", async t => {
  const f = await fixture(t), result = f.invoke("test_failure"), report = await f.report();
  assert.equal(result.status, 1);
  assert.deepEqual(report.diagnostics, { step: "test_process", kind: "process_exit", exit_code: 4,
    test_report: { report_available: true, failed_files: 1, failed_tests: 1, skipped_tests: 0, truncated: false,
      failures: [{ file_index: 1, file: "test/e2e/mcp-runner.e2e.test.ts", scope: "test", test_index: 1, kind: "assertion_failed" }] } });
  assert.equal(report.state, "failed");
  assert.ok(result.stderr.includes('"kind":"assertion_failed"'));
  assert.ok(!`${result.stdout}${result.stderr}${JSON.stringify(report)}`.includes("private"));
  const archived = JSON.parse(await readFile(join(f.directory, "ci-results/package-e2e.json"), "utf8"));
  assert.equal(archived.state, "failed");
  assert.deepEqual(archived.diagnostics, report.diagnostics);
  assert.match(archived.source.commit, /^[a-f0-9]{40}$/u);
});
test("AR08 suite setup failures survive raw report cleanup as a fixed error class", async t => {
  const f = await fixture(t), result = f.invoke("suite_failure"), report = await f.report();
  assert.equal(result.status, 1);
  assert.deepEqual(report.diagnostics.test_report.failures, [
    { file_index: 1, file: "test/e2e/mcp-runner.e2e.test.ts", scope: "suite", kind: "hook_timeout" },
  ]);
  assert.ok(!`${result.stdout}${result.stderr}${JSON.stringify(report)}`.includes("private"));
});
test("AR08 failure diagnostics cap retained failures and reject malformed failure reports", async t => {
  const f = await fixture(t), result = f.invoke("many_test_failures"), report = await f.report();
  assert.equal(result.status, 1); assert.equal(report.diagnostics.test_report.failed_tests, 40);
  assert.equal(report.diagnostics.test_report.failures.length, 16); assert.equal(report.diagnostics.test_report.truncated, true);
  assert.ok(JSON.stringify(report).length < 4096);
  const invalid = f.invoke("invalid_json_failure"), invalidReport = await f.report();
  assert.equal(invalid.status, 1); assert.deepEqual(invalidReport.diagnostics.test_report, { state: "invalid" });
  assert.ok(!`${invalid.stdout}${invalid.stderr}${JSON.stringify(invalidReport)}`.includes("private"));
});
for (const mode of ["missing_report", "bad_counts", "artifact_changed", "source_changed"]) {
  test(`AR08 actual wrapper rejects ${mode}`, async t => {
    const f = await fixture(t), result = f.invoke(mode);
    assert.notEqual(result.status, 0); assert.equal((await f.report()).state, "failed");
    assert.ok(!result.stderr.includes(f.directory));
    assert.ok(!`${result.stdout}${result.stderr}${JSON.stringify(await f.report())}`.includes("private"));
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
