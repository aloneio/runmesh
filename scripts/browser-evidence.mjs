import assert from "node:assert/strict";
import { summarizeVitest, testFailureEvidence, testErrorDiagnostic } from "./test-evidence.mjs";

export const REQUIRED_BROWSER_TEST = "renders stable single-locale dashboard and navigation in Chromium";
export const browserErrorDiagnostic = testErrorDiagnostic;

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
