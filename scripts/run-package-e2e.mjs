import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeVitest, packageEvidence } from "./test-evidence.mjs";
import { readBoundedEvidenceFile, readEvidenceJson } from "./evidence-io.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const reportDir = join(root, ".verification");
const reportPath = join(reportDir, "package-e2e.json");
const started = Date.now();
let temp, rawReport, testResult, phase = "preflight", step = "preflight", reportReady = false;
async function command(file, args, timeout = 120000, env = process.env) {
  return exec(file, args, { cwd: root, env, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}
async function sourceIdentity() {
  const git = async (...args) => (await command("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", ...args], 10000)).stdout.trim();
  const commit = await git("rev-parse", "HEAD"), tree = await git("rev-parse", "HEAD^{tree}");
  assert.match(commit, /^[a-f0-9]{40}$/u); assert.match(tree, /^[a-f0-9]{40}$/u);
  for (const declared of [process.env.GITHUB_SHA, process.env.CI_COMMIT_SHA]) if (declared) assert.equal(declared, commit, "CI source differs from checkout");
  return { commit, tree, state: await git("status", "--porcelain", "--untracked-files=all") === "" ? "clean" : "dirty" };
}
async function writeReport(value) {
  const path = join(reportDir, `${randomUUID()}.tmp`);
  try { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); await rename(path, reportPath); }
  finally { await rm(path, { force: true }); }
}
function failureKind(error) {
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output_limit_exceeded";
  if (error?.killed === true) return "process_terminated";
  if (Number.isSafeInteger(error?.code)) return "process_exit";
  if (error?.code === "ERR_ASSERTION") return "validation_failed";
  if (error?.code === "ENOENT") return "file_or_command_missing";
  if (["EACCES", "EPERM"].includes(error?.code)) return "permission_denied";
  if (["ENOSPC", "EMFILE", "ENFILE", "ENOMEM"].includes(error?.code)) return "resource_exhausted";
  if (error instanceof SyntaxError || error?.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
    || error?.message === "invalid_or_changed_evidence_file") return "invalid_evidence";
  return "operation_failed";
}
function testFailureKind(messages) {
  // Match bounded input, then emit only fixed labels. Test titles, assertion
  // values and stack traces can contain credentials even in a JSON reporter.
  const text = (Array.isArray(messages) ? messages : [messages]).slice(0, 8)
    .filter(value => typeof value === "string").map(value => value.slice(0, 16384)).join("\n");
  if (/hook timed out|hook timeout/iu.test(text)) return "hook_timeout";
  if (/test timed out|test timeout/iu.test(text)) return "test_timeout";
  if (/ECONNREFUSED/u.test(text)) return "connection_refused";
  if (/fetch failed/iu.test(text)) return "fetch_failed";
  if (/timed? ?out|ETIMEDOUT/iu.test(text)) return "timeout";
  if (/AssertionError|assertion failed/iu.test(text)) return "assertion_failed";
  if (/EACCES|EPERM/u.test(text)) return "permission_denied";
  return "unclassified";
}
function failedTestObservations(result) {
  if (!Array.isArray(result?.testResults)) return { state: "invalid" };
  const failures = [];
  let failedFiles = 0, failedTests = 0, observed = 0, truncated = result.testResults.length > 256;
  for (const [fileIndex, file] of result.testResults.slice(0, 256).entries()) {
    if (!file || typeof file !== "object") { truncated = true; continue; }
    const fileFailed = file.status === "failed";
    if (fileFailed) failedFiles++;
    const location = {
      file_index: fileIndex + 1,
      // Never print reporter paths, including apparently relative ones.
      file: typeof file.name === "string" && file.name.replaceAll("\\", "/").split("/").at(-1) === "mcp-runner.e2e.test.ts"
        ? "test/e2e/mcp-runner.e2e.test.ts" : "unrecognized_test_file",
    };
    let fileHasFailedTests = false;
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    for (const [testIndex, item] of assertions.entries()) {
      if (++observed > 10000) { truncated = true; break; }
      if (item?.status !== "failed") continue;
      failedTests++; fileHasFailedTests = true;
      if (failures.length < 16) failures.push({ ...location, scope: "test", test_index: testIndex + 1, kind: testFailureKind(item.failureMessages) });
      else truncated = true;
    }
    if (fileFailed && !fileHasFailedTests) {
      if (failures.length < 16) failures.push({ ...location, scope: "suite", kind: testFailureKind(file.message) });
      else truncated = true;
    }
    if (observed > 10000) break;
  }
  // These observations explain a failed attempt; they never satisfy the
  // success counters or integrity gates in summarizeVitest/packageEvidence.
  return { state: "parsed", failed_files: failedFiles, failed_tests: failedTests, failures, truncated };
}
async function failureDiagnostics(error) {
  const diagnostics = { step, kind: failureKind(error) };
  if (Number.isSafeInteger(error?.code) && error.code >= 0 && error.code <= 0xffffffff) diagnostics.exit_code = error.code;
  if (["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"].includes(error?.signal)) diagnostics.signal = error.signal;
  if (rawReport) {
    // Only a failed child needs a first read here. Do not retry evidence that
    // already failed validation or file-identity checks in the success path.
    if (testResult === undefined && step === "test_process") {
      try { testResult = await readEvidenceJson(rawReport); }
      catch (readError) { diagnostics.test_report = { state: readError?.code === "ENOENT" ? "missing" : "invalid" }; }
    }
    diagnostics.test_report ??= testResult === undefined
      ? { state: error?.code === "ENOENT" ? "missing" : "invalid" }
      : failedTestObservations(testResult);
  }
  return diagnostics;
}
try {
  assert.equal(process.argv.length, 2, "Use npm run test:package:e2e without arbitrary arguments");
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(reportDir); assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  reportReady = true;
  await writeReport({ schema_version: 1, evidence: "local_packaged_runner_e2e", state: "not_run", phase });
  const source = await sourceIdentity();
  const npm = process.env.npm_execpath;
  assert.ok(npm && isAbsolute(npm) && basename(npm) === "npm-cli.js", "Run through the installed npm CLI");
  temp = await mkdtemp(join(tmpdir(), "runmesh-ar08-package-"));
  phase = "pack"; step = "pack_process";
  await command(process.execPath, [npm, "pack", "--workspace=@aloneio/runmesh-runner", "--json", "--pack-destination", temp]);
  // npm lifecycle scripts can prepend ordinary text even with --json. The
  // fresh private output directory, not human-oriented stdout, owns the asset.
  step = "archive_validation";
  const archives = (await readdir(temp)).filter(name => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "exactly one generated archive is required");
  const filename = archives[0]; assert.match(filename, /^[A-Za-z0-9._-]+\.tgz$/u);
  const archive = join(temp, filename);
  const archiveBytes = await readBoundedEvidenceFile(archive);
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const artifact = { sha256: digest(archiveBytes), bytes: archiveBytes.byteLength };
  phase = "installed_package_e2e"; step = "test_process";
  rawReport = join(temp, "vitest.json");
  const result = await command(process.execPath, [join(root, "scripts/test-packed-runner.mjs"), archive], 420000,
    { ...process.env, RUNMESH_TEST_RESULT_PATH: rawReport });
  step = "test_report_read";
  testResult = await readEvidenceJson(rawReport);
  step = "test_report_validation";
  const tests = summarizeVitest(testResult, 0);
  step = "artifact_integrity";
  assert.equal(digest(await readBoundedEvidenceFile(archive)), artifact.sha256, "archive changed during verification");
  step = "source_integrity";
  assert.deepEqual(await sourceIdentity(), source, "source changed during verification");
  const report = packageEvidence({ tests, source, artifact, platform: process.platform, arch: process.arch, node: process.version, elapsedMs: Date.now() - started });
  step = "report_write";
  await writeReport(report);
  // Forward the existing successful logs only after every gate passes. A
  // failed attempt emits the bounded diagnostics below, never raw output.
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  console.log(JSON.stringify(report));
  console.log("AR08_PACKAGED_E2E_VERIFIED");
} catch (error) {
  // No old successful report survives a failed attempt. Do not print raw
  // subprocess exceptions, filesystem paths or credential-bearing logs here.
  const diagnostics = await failureDiagnostics(error);
  if (reportReady) await writeReport({ schema_version: 1, evidence: "local_packaged_runner_e2e", state: "failed", phase, diagnostics }).catch(() => undefined);
  console.error(`packaged_e2e_failed: ${JSON.stringify({ phase, diagnostics })}`);
  process.exitCode = 1;
} finally { if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
