import { checkGuidedProduct } from "./product-browser-check.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { browserEvidence, browserFailureEvidence, browserErrorDiagnostic } from "./browser-evidence.mjs";
import { mcpWorkerFailureEvidence } from "./mcp-diagnostics.mjs";
import { writeSupplement } from "./ci-supplement.mjs";
import { ROOT, gateEvidence, sourceObservation, writeGateReport } from "./ci-report.mjs";
import { writeBuildProvenance } from "./build-provenance.mjs";
import { runFixtureCommand } from "./worker-fixture.mjs";

const start = Date.now(), source = sourceObservation(); let temporaryRoot, directory, path, code = 1, stage = "configuration", termination;
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
    cwd: ROOT, timeout: 420000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true", RUNMESH_TEST_RESULT_PATH: path, RUNMESH_CHROMIUM_EXECUTABLE: executable, RUNMESH_BROWSER_OUTPUT: "" },
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  stage = "guided_product";
  const guidedProduct = await checkGuidedProduct(executable);
  stage = "evidence_validation";
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024);
  const evidence = browserEvidence(JSON.parse(await readFile(path, "utf8")), 0);
  await writeSupplement("browser-tests", { schema_version: 1, evidence: "real_local_browser_e2e", attestation: "self_reported", source, ...evidence, runtime: { node: process.version, platform: process.platform, arch: process.arch }, production: "not_run" });
  console.log(JSON.stringify({ browser_gate: "passed", guided_product: guidedProduct, ...evidence })); code = 0;
} catch (error) {
  termination = error?.termination_reason;
  // Publish only classified failures and public source coordinates, never raw
  // subprocess stderr, reports, assertion values, cookies, or screenshots.
  let failure = { report_available: false };
  try {
    const stat = await lstat(path);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024) failure = browserFailureEvidence(JSON.parse(await readFile(path, "utf8")));
  } catch { /* A missing or malformed private report remains unavailable. */ }
  const workerEvents = mcpWorkerFailureEvidence(error?.stderr);
  const diagnostics = { stage, error: browserErrorDiagnostic(error), subprocess_exit_code: stage === "test_execution" && Number.isSafeInteger(error?.code) ? error.code : null,
    ...failure, ...(workerEvents.length > 0 ? { worker_events: workerEvents } : {}) };
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
