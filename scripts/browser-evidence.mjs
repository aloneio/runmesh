import assert from "node:assert/strict";
import { summarizeVitest } from "./test-evidence.mjs";

export const REQUIRED_BROWSER_TEST = "renders stable single-locale dashboard and navigation in Chromium";
export function browserEvidence(raw, exitCode) {
  const tests = summarizeVitest(raw, exitCode);
  const required = raw.testResults.flatMap(file => file.assertionResults).filter(item => item.title === REQUIRED_BROWSER_TEST || item.fullName?.endsWith(REQUIRED_BROWSER_TEST));
  assert.equal(required.length, 1, "the actual browser test must run exactly once");
  assert.equal(required[0].status, "passed", "a skipped browser check is not verification");
  assert.equal(tests.skipped, 0, "the required Linux browser lane must have no skips");
  assert.equal(tests.todo, 0, "TODO tests cannot certify browser acceptance");
  return { required_browser_checks: 1, tests };
}
