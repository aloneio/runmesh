import { checkGuidedProduct } from "./product-browser-check.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserEvidence, browserFailureEvidence } from "./browser-evidence.mjs";
import { writeSupplement } from "./ci-supplement.mjs";
import { ROOT, gateEvidence, sourceObservation, writeGateReport } from "./ci-report.mjs";

const start = Date.now(), source = sourceObservation(); let directory, path, code = 1, stage = "configuration";
await writeGateReport(gateEvidence("browser", "running", 0, null, source));
await writeSupplement("browser-tests", { schema_version: 1, state: "not_run", source });
try {
  assert.equal(process.argv.length, 2, "browser gate does not accept arbitrary arguments");
  assert.equal(process.platform, "linux", "browser gate requires the declared Linux runtime");
  directory = await mkdtemp(join(tmpdir(), "runmesh-browser-gate-"));
  path = join(directory, "result.json");
  stage = "browser_setup";
  // CI uses the lockfile-bound Playwright Chromium. A local operator may use
  // an explicit absolute browser path; it is a test setting, never a runtime
  // Worker variable and never a browser profile from the user's machine.
  const executable = process.env.RUNMESH_CHROMIUM_EXECUTABLE ?? (await import("playwright")).chromium.executablePath();
  assert.ok(executable.startsWith("/"));
  const browser = await lstat(executable); assert.ok(browser.isFile() || browser.isSymbolicLink());
  stage = "test_execution";
  const result = await promisify(execFile)(process.execPath, [join(ROOT, "scripts/run-e2e.mjs")], {
    cwd: ROOT, timeout: 420000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, RUNMESH_BROWSER_CHECK: "1", RUNMESH_TEST_RESULT_PATH: path, RUNMESH_CHROMIUM_EXECUTABLE: executable, RUNMESH_BROWSER_OUTPUT: "" },
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
  // Do not publish subprocess stderr, raw reports, cookies, or screenshots.
  let failure = { report_available: false };
  try {
    const stat = await lstat(path);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024) failure = browserFailureEvidence(JSON.parse(await readFile(path, "utf8")));
  } catch { /* A missing or malformed private report remains unavailable. */ }
  const diagnostics = { stage, subprocess_exit_code: stage === "test_execution" && Number.isSafeInteger(error?.code) ? error.code : null, ...failure };
  await writeSupplement("browser-tests", { schema_version: 1, state: "failed", source, ...diagnostics });
  console.error(JSON.stringify({ browser_gate: "failed", ...diagnostics }));
  console.error("browser_gate_failed: missing, skipped or failing real browser evidence; inspect the CI job");
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
  await writeGateReport(gateEvidence("browser", code === 0 ? "passed" : "failed", Date.now() - start, code, source));
  process.exitCode = code;
}
