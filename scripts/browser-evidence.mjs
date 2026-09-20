import assert from "node:assert/strict";
import { summarizeVitest } from "./test-evidence.mjs";

export const REQUIRED_BROWSER_TEST = "renders stable single-locale dashboard and navigation in Chromium";
export function browserFailureEvidence(raw) {
  if (!Array.isArray(raw?.testResults)) return { report_available: false };
  const assertions = raw.testResults.flatMap(file => Array.isArray(file?.assertionResults) ? file.assertionResults : []);
  const required = assertions.filter(item => item?.title === REQUIRED_BROWSER_TEST || (typeof item?.fullName === "string" && item.fullName.endsWith(REQUIRED_BROWSER_TEST)));
  const status = required.length === 1 && ["passed", "failed", "pending", "skipped", "todo"].includes(required[0].status) ? required[0].status : "unknown";
  return { report_available: true, required_browser_checks: required.length, required_browser_status: status,
    failed_tests: assertions.filter(item => item?.status === "failed").length,
    skipped_tests: assertions.filter(item => item?.status === "pending" || item?.status === "skipped").length };
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
