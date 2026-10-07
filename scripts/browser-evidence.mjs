import assert from "node:assert/strict";
import { summarizeVitest, testFailureEvidence, testErrorDiagnostic, projectTestErrorDiagnostic } from "./test-evidence.mjs";

export const REQUIRED_BROWSER_TEST = "renders stable single-locale dashboard and navigation in Chromium";
export const browserErrorDiagnostic = testErrorDiagnostic;

const guidedStages = Object.freeze(["layout", "layout_setup", "layout_auth", "layout_navigation", "layout_localization", "layout_measure", "layout_forms", "layout_resize", "layout_cleanup",
  "navigation", "navigation_handoffs", "runner_actions", "product_setup", "central_recovery", "client_permissions", "skill_file_errors", "central_management", "skill_uploads", "product_workflows", "product_cleanup"]);
const fixturePhases = Object.freeze(["primary", "browser_close", "fixture_close", "temporary_cleanup"]);

export function guidedProductStageMarker(stage) {
  assert.ok(guidedStages.includes(stage));
  return `RUNMESH_GUIDED_PRODUCT_STAGE=${stage}\n`;
}
export function guidedProductStageEvidence(stdout) {
  if (typeof stdout !== "string") return undefined;
  let stage;
  for (const match of stdout.slice(0, 8 * 1024 * 1024).matchAll(/^RUNMESH_GUIDED_PRODUCT_STAGE=([a-z_]+)\r?$/gmu))
    if (guidedStages.includes(match[1])) stage = match[1];
  return stage;
}
export function browserFixtureFailureEvidence(stderr) {
  if (typeof stderr !== "string") return [];
  const failures = [], seen = new Set();
  for (const match of stderr.slice(0, 8 * 1024 * 1024).matchAll(/^RUNMESH_BROWSER_FIXTURE_FAILURE=(\{[^\r\n]{1,768}\})\r?$/gmu)) {
    try {
      const value = JSON.parse(match[1]), error = projectTestErrorDiagnostic(value?.error);
      if (fixturePhases.includes(value?.phase) && error && !seen.has(value.phase)) {
        seen.add(value.phase); failures.push({ phase: value.phase, error });
      }
    } catch { /* Private or malformed lines are not evidence. */ }
  }
  return failures;
}

/** Lifecycle orchestration is explicit; evidence projection never writes output. */
export async function withBrowserFixtureCleanup(operation, cleanups, emit) {
  let primaryFailed = false;
  const report = (phase, error) => {
    if (!fixturePhases.includes(phase)) return;
    try { emit(`RUNMESH_BROWSER_FIXTURE_FAILURE=${JSON.stringify({ phase, error: projectTestErrorDiagnostic(browserErrorDiagnostic(error)) })}\n`); }
    catch { /* Diagnostics cannot replace the original failure or stop cleanup. */ }
  };
  try { return await operation(); }
  catch (error) { primaryFailed = true; report("primary", error); throw error; }
  finally {
    const failures = [];
    // Start every independent cleanup even if another one is slow. The gate's
    // existing process deadline remains responsible for a permanently stuck child.
    await Promise.all(cleanups.map(async ({ phase, run }) => {
      try { assert.ok(fixturePhases.includes(phase) && phase !== "primary"); await run(); }
      catch (error) { failures.push(error); report(phase, error); }
    }));
    if (!primaryFailed && failures.length > 0) throw new AggregateError(failures, "Browser fixture cleanup failed");
  }
}

export function browserFailureEvidence(raw) {
  const summary = testFailureEvidence(raw);
  if (!summary.report_available) return summary;
  const required = []; let observed = 0;
  for (const [fileIndex, file] of raw.testResults.slice(0, 256).entries()) {
    for (const [testIndex, item] of (Array.isArray(file?.assertionResults) ? file.assertionResults.slice(0, 10000) : []).entries()) {
      if (++observed > 10000) break;
      if (item?.title === REQUIRED_BROWSER_TEST || (typeof item?.fullName === "string" && item.fullName.endsWith(REQUIRED_BROWSER_TEST)))
        required.push({ file_index: fileIndex + 1, test_index: testIndex + 1, status: item.status });
    }
    if (observed > 10000) break;
  }
  const status = required.length === 1 && ["passed", "failed", "pending", "skipped", "todo"].includes(required[0].status) ? required[0].status : "unknown";
  return { ...summary, required_browser_checks: required.length, required_browser_status: status,
    failures: summary.failures.map(failure => ({ ...failure, required_browser_check: failure.scope === "test"
      && required.some(item => item.file_index === failure.file_index && item.test_index === failure.test_index) })) };
}
export function browserEvidence(raw, exitCode) {
  const tests = summarizeVitest(raw, exitCode);
  const required = raw.testResults.flatMap(file => file.assertionResults).filter(item => item.title === REQUIRED_BROWSER_TEST || item.fullName?.endsWith(REQUIRED_BROWSER_TEST));
  assert.equal(required.length, 1, "the actual browser test must run exactly once");
  assert.equal(required[0].status, "passed", "a skipped browser check is not verification");
  assert.equal(tests.skipped, 0, "the required Linux browser lane must have no skips");
  assert.equal(tests.todo, 0, "TODO tests cannot certify browser acceptance");
  return { required_browser_checks: 1, tests };
}
