import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeVitest, packageEvidence, testFailureEvidence, testErrorDiagnostic } from "./test-evidence.mjs";
import { sourceObservation } from "./ci-report.mjs";
import { writeSupplement } from "./ci-supplement.mjs";
import { mcpWorkerFailureEvidence } from "./mcp-diagnostics.mjs";
import { readBoundedEvidenceFile, readEvidenceJson } from "./evidence-io.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const reportDir = join(root, ".verification");
const reportPath = join(reportDir, "package-e2e.json");
const started = Date.now();
let source = sourceObservation();
let temp, rawReport, testResult, completed, phase = "preflight", step = "preflight", reportReady = false, failed = false;
async function command(file, args, timeout = 120000, env = process.env) {
  return exec(file, args, { cwd: root, env, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}
function sourceIdentity() {
  const observed = sourceObservation(root);
  assert.notEqual(observed.state, "unknown", "CI source observation unavailable");
  for (const declared of [process.env.GITHUB_SHA, process.env.CI_COMMIT_SHA]) if (declared) assert.equal(declared, observed.commit, "CI source differs from checkout");
  return observed;
}
async function writeReport(value) {
  const path = join(reportDir, `${randomUUID()}.tmp`);
  try { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); await rename(path, reportPath); }
  finally { await rm(path, { force: true }); }
  await writeSupplement("package-e2e", { ...value, source });
}
async function failureDiagnostics(error) {
  const diagnostics = { step, ...testErrorDiagnostic(error) };
  const workerEvents = mcpWorkerFailureEvidence(error?.stderr);
  if (workerEvents.length > 0) diagnostics.worker_events = workerEvents;
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
      : testFailureEvidence(testResult);
  }
  return diagnostics;
}
async function recordFailure(error) {
  // Keep the primary failure if cleanup also fails. Every failure emits bounded
  // diagnostics, without raw subprocess output or filesystem paths.
  const diagnostics = await failureDiagnostics(error);
  if (!failed && reportReady) await writeReport({ schema_version: 1, evidence: "local_packaged_runner_e2e", state: "failed", phase, diagnostics }).catch(() => undefined);
  failed = true;
  console.error(`packaged_e2e_failed: ${JSON.stringify({ phase, diagnostics })}`);
  process.exitCode = 1;
}
try {
  assert.equal(process.argv.length, 2, "Use npm run test:package:e2e without arbitrary arguments");
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(reportDir); assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  reportReady = true;
  await writeReport({ schema_version: 1, evidence: "local_packaged_runner_e2e", state: "not_run", phase });
  source = await sourceIdentity();
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
  completed = { tests, artifact, result };
} catch (error) {
  await recordFailure(error);
} finally {
  if (temp) {
    try { await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
    catch (error) { phase = "cleanup"; step = "temporary_cleanup"; await recordFailure(error); }
  }
}
if (!failed && completed) try {
  step = "source_integrity";
  assert.deepEqual(await sourceIdentity(), source, "source changed during verification");
  const { tests, artifact, result } = completed;
  const report = packageEvidence({ tests, source, artifact, platform: process.platform, arch: process.arch, node: process.version, elapsedMs: Date.now() - started });
  step = "report_write";
  await writeReport(report);
  // Publish successful evidence only after cleanup and every gate passes. A
  // failed attempt emits the bounded diagnostics below, never raw output.
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  console.log(JSON.stringify(report));
  console.log("AR08_PACKAGED_E2E_VERIFIED");
} catch (error) {
  await recordFailure(error);
}
