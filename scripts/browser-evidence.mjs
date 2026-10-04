import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { summarizeVitest } from "./test-evidence.mjs";

export const REQUIRED_BROWSER_TEST = "renders stable single-locale dashboard and navigation in Chromium";
const browserSources = ["ui-browser-check.mjs", "product-browser-check.mjs", "product-browser-fixture.mjs",
  "navigation-browser-check.mjs", "layout-browser-check.mjs", "runner-browser-check.mjs", "skill-upload-browser-check.mjs", "run-browser-e2e.mjs"];
const browserOperations = ["Runtime.evaluate", "Page.navigate", "Page.getFrameTree", "Target.createTarget", "Target.attachToTarget",
  "Page.enable", "Runtime.enable", "Network.enable", "Network.setCookies", "Network.setCookie", "Emulation.setDeviceMetricsOverride", "Browser.close"];
const failureKinds = [
  [/Browser startup timed out/u, "browser_startup_timeout"],
  [/Browser navigation readiness timed out/u, "browser_navigation_timeout"],
  [/Browser operation timed out/u, "browser_operation_timeout"],
  [/Execution context was destroyed|Cannot find (?:default execution context|context with specified id)|Inspected target navigated or closed/u, "navigation_context_lost"],
  [/hook timed out|hook timeout/iu, "hook_timeout"], [/test timed out|test timeout/iu, "test_timeout"],
  [/ECONNREFUSED/u, "connection_refused"], [/fetch failed/iu, "fetch_failed"],
  [/timed? ?out|ETIMEDOUT/iu, "timeout"], [/AssertionError|assertion failed/iu, "assertion_failed"],
];

function failureDetails(messages) {
  // Reporter messages can contain credentials and response bodies. Match bounded
  // input, then emit fixed labels and public source coordinates only.
  const text = stripVTControlCharacters((Array.isArray(messages) ? messages : [messages]).slice(0, 8)
    .filter(value => typeof value === "string").map(value => value.slice(0, 16384)).join("\n")).replaceAll("\\", "/");
  const details = { kind: failureKinds.find(([pattern]) => pattern.test(text))?.[1] ?? "unclassified" };
  const source = /(?:^|[\s(/])((?:scripts\/[a-z-]+\.mjs|test\/e2e\/mcp-runner\.e2e\.test\.ts)):(\d{1,7}):(\d{1,5})(?=$|[\s)])/gmu;
  for (const match of text.matchAll(source)) {
    if ((match[1] === "test/e2e/mcp-runner.e2e.test.ts" || browserSources.some(name => match[1] === "scripts/" + name))
      && Number(match[2]) > 0 && Number(match[3]) > 0) {
      details.location = { file: match[1], line: Number(match[2]), column: Number(match[3]) }; break;
    }
  }
  const operation = /Browser operation timed out: ([A-Za-z.]+)(?=$|[\s)])/mu.exec(text)?.[1];
  if (details.kind === "browser_operation_timeout" && browserOperations.includes(operation)) details.operation = operation;
  return details;
}

export function browserErrorDiagnostic(error) {
  const details = failureDetails([error?.message, error?.stack]);
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") details.kind = "output_limit_exceeded";
  else if (error?.killed === true) details.kind = "process_terminated";
  else if (Number.isSafeInteger(error?.code) && error.code >= 0) details.kind = "process_exit";
  else if (error?.code === "ERR_ASSERTION") details.kind = "assertion_failed";
  else if (error?.code === "ENOENT") details.kind = "file_or_command_missing";
  else if (["EACCES", "EPERM"].includes(error?.code)) details.kind = "permission_denied";
  else if (error instanceof SyntaxError) details.kind = "invalid_evidence";
  return details;
}

export function browserFailureEvidence(raw) {
  if (!Array.isArray(raw?.testResults)) return { report_available: false };
  const assertions = raw.testResults.flatMap(file => Array.isArray(file?.assertionResults) ? file.assertionResults : []);
  const required = assertions.filter(item => item?.title === REQUIRED_BROWSER_TEST || (typeof item?.fullName === "string" && item.fullName.endsWith(REQUIRED_BROWSER_TEST)));
  const status = required.length === 1 && ["passed", "failed", "pending", "skipped", "todo"].includes(required[0].status) ? required[0].status : "unknown";
  const failed = assertions.flatMap((item, index) => item?.status === "failed" ? [{ item, index }] : []);
  const failures = failed.slice(0, 16).map(({ item, index }) => ({ test_index: index + 1, required_browser_check: required.includes(item), ...failureDetails(item.failureMessages) }));
  return { report_available: true, required_browser_checks: required.length, required_browser_status: status,
    failed_tests: failed.length,
    skipped_tests: assertions.filter(item => item?.status === "pending" || item?.status === "skipped").length,
    failures, truncated: failed.length > failures.length };
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
