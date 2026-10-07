import assert from "node:assert/strict";
import { mkdtemp, lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { browserEvidence, browserFailureEvidence, browserErrorDiagnostic, browserFixtureFailureEvidence, guidedProductStageEvidence } from "./browser-evidence.mjs";
import { mcpWorkerFailureEvidence } from "./mcp-diagnostics.mjs";
import { writeSupplement } from "./ci-supplement.mjs";
import { ROOT, gateEvidence, sourceObservation, assertSourceObservationUnchanged, writeGateReport } from "./ci-report.mjs";
import { writeBuildProvenance } from "./build-provenance.mjs";
import { runFixtureCommand } from "./worker-fixture.mjs";
import { readEvidenceJson } from "./evidence-io.mjs";

const start = Date.now(), source = sourceObservation(); let temporaryRoot, directory, path, rawReport, code = 1, stage = "configuration", termination, guided;
// Both suites, including their fixture cleanup, share one process budget.
// A stalled guided check must still leave time for the gate to record failure.
const deadline = start + 420000;
function remainingBudget() {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Object.assign(new Error("Fixture command timed out"), { termination_reason: "timeout", killed: true });
  return remaining;
}
await writeGateReport(gateEvidence("browser", "running", 0, null, source));
await writeSupplement("browser-tests", { schema_version: 1, state: "not_run", source });
try {
  assert.equal(process.argv.length, 2, "browser gate does not accept arbitrary arguments");
  assert.equal(process.platform, "linux", "browser gate requires the declared Linux runtime");
  temporaryRoot = await realpath(tmpdir());
  directory = await mkdtemp(join(temporaryRoot, "runmesh-browser-gate-"));
  path = join(directory, "result.json");
  stage = "browser_setup";
  // CI uses the lockfile-bound Playwright Chromium. A local operator may use
  // an explicit absolute browser path; it is a test setting, never a runtime
  // Worker variable and never a browser profile from the user's machine.
  const executable = process.env.RUNMESH_CHROMIUM_EXECUTABLE ?? (await import("playwright")).chromium.executablePath();
  assert.ok(executable.startsWith("/"));
  const browser = await lstat(executable); assert.ok(browser.isFile() || browser.isSymbolicLink());
  await writeBuildProvenance(ROOT);
  stage = "test_execution";
  const result = await runFixtureCommand(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.browser.config.ts"], {
    cwd: ROOT, timeout: remainingBudget(), maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true", RUNMESH_TEST_RESULT_PATH: path, RUNMESH_CHROMIUM_EXECUTABLE: executable, RUNMESH_BROWSER_OUTPUT: "" },
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  stage = "guided_product";
  guided = await runFixtureCommand(process.execPath, [join(ROOT, "scripts/product-browser-check.mjs")], {
    cwd: ROOT, timeout: remainingBudget(), maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, RUNMESH_CHROMIUM_EXECUTABLE: executable },
  });
  // The product CLI ends with a result. Keep its assertion values and other
  // output private, projecting only the fixed fields needed for acceptance.
  const completed = JSON.parse(guided.stdout.trim().split(/\r?\n/u).at(-1));
  assert.equal(completed?.state, "passed", "guided product checks did not pass");
  assert.equal(completed.screenshots, 0, "guided product evidence must use DOM checks");
  const guidedProduct = { state: "passed", screenshots: 0 };
  stage = "evidence_validation";
  rawReport = await readEvidenceJson(path);
  const evidence = browserEvidence(rawReport, 0);
  stage = "source_validation";
  assertSourceObservationUnchanged(source);
  await writeSupplement("browser-tests", { schema_version: 1, evidence: "real_local_browser_e2e", attestation: "self_reported", source, ...evidence, runtime: { node: process.version, platform: process.platform, arch: process.arch }, production: "not_run" });
  console.log(JSON.stringify({ browser_gate: "passed", guided_product: guidedProduct, ...evidence })); code = 0;
} catch (error) {
  termination = error?.termination_reason;
  // Publish only classified failures and public source coordinates, never raw
  // subprocess stderr, reports, assertion values, cookies, or screenshots.
  let failure = { report_available: false };
  try {
    // A failed child needs one bounded read. Reuse evidence already read in
    // the success path; a failed file validation must never retry that path.
    if (rawReport === undefined && ["test_execution", "guided_product"].includes(stage)) rawReport = await readEvidenceJson(path);
    failure = browserFailureEvidence(rawReport);
  } catch { /* A missing or malformed private report remains unavailable. */ }
  const workerEvents = mcpWorkerFailureEvidence(error?.stderr);
  const guidedStage = stage === "guided_product" ? guidedProductStageEvidence(error?.stdout ?? guided?.stdout) : undefined;
  const guidedFailures = stage === "guided_product" ? browserFixtureFailureEvidence(error?.stderr ?? guided?.stderr) : [];
  const diagnostics = { stage, error: browserErrorDiagnostic(error), subprocess_exit_code: ["test_execution", "guided_product"].includes(stage) && Number.isSafeInteger(error?.code) ? error.code : null,
    ...failure, ...(workerEvents.length > 0 ? { worker_events: workerEvents } : {}),
    ...(["timeout", "interrupted", "output_limit"].includes(termination) ? { termination_reason: termination } : {}),
    ...(guidedStage === undefined ? {} : { guided_product_stage: guidedStage }),
    ...(guidedFailures.length > 0 ? { guided_product_failures: guidedFailures } : {}),
    ...(stage === "guided_product" && typeof error?.stderr === "string" && error.stderr.length > 0
      ? { guided_product_error: guidedFailures.find(failure => failure.phase === "primary")?.error
        ?? browserErrorDiagnostic({ message: error.stderr }) } : {}) };
  await writeSupplement("browser-tests", { schema_version: 1, state: "failed", source, ...diagnostics });
  console.error(JSON.stringify({ browser_gate: "failed", ...diagnostics }));
  console.error("browser_gate_failed: missing, skipped or failing real browser evidence; inspect the CI job");
} finally {
  try {
    try {
      if (directory) {
        assert.ok(isAbsolute(directory) && dirname(directory) === temporaryRoot && basename(directory).startsWith("runmesh-browser-gate-"));
        await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    } catch (error) {
      const passed = code === 0; code = 1;
      const diagnostics = { stage: "cleanup", error: browserErrorDiagnostic(error), report_available: false };
      console.error(JSON.stringify({ browser_gate: "failed", ...diagnostics }));
      if (passed) await writeSupplement("browser-tests", { schema_version: 1, state: "failed", source, ...diagnostics });
    }
  } finally {
    process.exitCode = code;
    await writeGateReport(gateEvidence("browser", termination === "timeout" ? "timed_out" : termination === "interrupted" ? "cancelled" : code === 0 ? "passed" : "failed", Date.now() - start, code, source));
  }
}
