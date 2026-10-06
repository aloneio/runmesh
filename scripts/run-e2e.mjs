import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeBuildProvenance } from "./build-provenance.mjs";
import { sourceObservation, gateEvidence, writeGateReport } from "./ci-report.mjs";
import { writeSupplement } from "./ci-supplement.mjs";
import { readEvidenceJson } from "./evidence-io.mjs";
import { summarizeVitest, testFailureEvidence, testErrorDiagnostic } from "./test-evidence.mjs";
import { mcpWorkerFailureEvidence } from "./mcp-diagnostics.mjs";
import { runFixtureCommand } from "./worker-fixture.mjs";

// One transport entrypoint owns the bounded process tree and safe observations
// on Linux, Windows and installed-package runs. Raw reporter output stays private.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packaged = process.env.RUNMESH_E2E_RUNNER_ENTRY !== undefined;
const source = sourceObservation(), started = Date.now();
let directory, report, result, stage = "configuration", code = 1, termination;
if (!packaged) {
  await writeGateReport(gateEvidence("transport", "running", 0, null, source));
  await writeSupplement("transport-tests", { schema_version: 1, state: "not_run", source });
}
try {
  assert.equal(process.argv.length, 2, "transport gate does not accept arbitrary arguments");
  directory = await mkdtemp(join(tmpdir(), "runmesh-transport-gate-"));
  report = process.env.RUNMESH_TEST_RESULT_PATH ?? join(directory, "result.json");
  // The caller-designated private output must describe this attempt. A process
  // that exits without writing a report cannot reuse a previous success.
  await rm(report, { force: true });
  stage = "build_provenance";
  await writeBuildProvenance(repositoryRoot);
  const vitest = resolve(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
  stage = "test_execution";
  const timeoutValue = Number.parseInt(process.env.RUNMESH_E2E_TIMEOUT_MS ?? "300000", 10);
  const timeout = Number.isSafeInteger(timeoutValue) && timeoutValue > 0 && timeoutValue <= 900000 ? timeoutValue : 300000;
  const output = await runFixtureCommand(process.execPath, [vitest, "run", "--config", "vitest.e2e.config.ts"], {
    cwd: repositoryRoot, timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true", RUNMESH_TEST_RESULT_PATH: report },
  });
  stage = "evidence_validation";
  result = await readEvidenceJson(report);
  const tests = summarizeVitest(result, 0);
  if (!packaged) await writeSupplement("transport-tests", { schema_version: 1, evidence: "local_transport_e2e", attestation: "self_reported",
    state: "passed", source, runtime: { node: process.version, platform: process.platform, arch: process.arch }, tests, production: "not_run" });
  process.stdout.write(output.stdout); process.stderr.write(output.stderr);
  console.log(JSON.stringify({ transport_gate: "passed", tests }));
  code = 0;
} catch (error) {
  termination = error?.termination_reason;
  // Do not retry a report whose validation already failed. A missing report is
  // itself useful failure evidence when a worker, suite or subprocess never ran.
  if (result === undefined && stage === "test_execution") {
    try { result = await readEvidenceJson(report); } catch { /* Private evidence remains unavailable. */ }
  }
  const workerEvents = mcpWorkerFailureEvidence(error?.stderr);
  const diagnostics = { stage, error: testErrorDiagnostic(error), subprocess_exit_code: stage === "test_execution" && Number.isSafeInteger(error?.code) ? error.code : null,
    ...testFailureEvidence(result), ...(workerEvents.length > 0 ? { worker_events: workerEvents } : {}) };
  if (!packaged) await writeSupplement("transport-tests", { schema_version: 1, state: "failed", source, ...diagnostics });
  console.error(JSON.stringify({ transport_gate: "failed", ...diagnostics }));
  if (packaged) for (const event of workerEvents) console.error("RUNMESH_E2E_MCP_WORKER_EVENT=" + JSON.stringify(event));
} finally {
  try { if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  catch (error) {
    const diagnostics = { stage: "cleanup", error: testErrorDiagnostic(error), report_available: false };
    if (!packaged && code === 0) await writeSupplement("transport-tests", { schema_version: 1, state: "failed", source, ...diagnostics });
    console.error(JSON.stringify({ transport_gate: "failed", ...diagnostics })); code = 1;
  }
  if (!packaged) await writeGateReport(gateEvidence("transport", termination === "timeout" ? "timed_out" : termination === "interrupted" ? "cancelled" : code === 0 ? "passed" : "failed", Date.now() - started, code, source));
  process.exitCode = code;
}
