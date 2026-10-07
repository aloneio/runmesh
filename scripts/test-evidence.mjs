import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { UI_BROWSER_STAGES, UI_BROWSER_NAVIGATION_STATES } from "./ui-browser-contract.mjs";
import { jobCompletionDiagnostic, mcpHttpDiagnostic, mcpToolResultFailureDiagnostic } from "./mcp-diagnostics.mjs";
import { uiNavigationFailureDiagnostic } from "./ui-browser-diagnostics.mjs";

const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const testStates = { passed: "passed", failed: "failed", pending: "skipped", skipped: "skipped", todo: "todo" };
const testFiles = ["test/e2e/mcp-runner.e2e.test.ts", "test/browser/admin-ui.browser.test.ts"];

/** Failed attempts are observations, never a substitute for success counters.
 * Retain only reviewed module names, bounded indexes and classified errors. */
export function testFailureEvidence(result) {
  if (!Array.isArray(result?.testResults)) return { report_available: false };
  const failures = [];
  let failedFiles = 0, failedTests = 0, skippedTests = 0, observed = 0, truncated = result.testResults.length > 256;
  const retain = (value, messages) => { if (failures.length < 16) failures.push({ ...value, ...testFailureDetails(messages) }); else truncated = true; };
  for (const [fileIndex, file] of result.testResults.slice(0, 256).entries()) {
    if (!file || typeof file !== "object") { truncated = true; continue; }
    if (file.status === "failed") failedFiles++;
    const name = typeof file.name === "string" ? file.name.replaceAll("\\", "/") : "";
    const location = { file_index: fileIndex + 1, file: testFiles.find(value => name === value || name.endsWith("/" + value)) ?? "unrecognized_test_file" };
    let fileHasFailedTests = false;
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    for (const [testIndex, item] of assertions.entries()) {
      if (++observed > 10000) { truncated = true; break; }
      if (item?.status === "pending" || item?.status === "skipped") skippedTests++;
      if (item?.status !== "failed") continue;
      failedTests++; fileHasFailedTests = true;
      retain({ ...location, scope: "test", test_index: testIndex + 1 }, item.failureMessages);
    }
    if (file.status === "failed" && !fileHasFailedTests)
      retain({ ...location, scope: "suite" }, file.message);
    if (observed > 10000) break;
  }
  return { report_available: true, failed_files: failedFiles, failed_tests: failedTests, skipped_tests: skippedTests, failures, truncated };
}

/** Counters only: never export test names, errors, stack traces or paths.
 * An exit code alone is not evidence that any required test actually ran.
 */
export function summarizeVitest(result, exitCode) {
  assert.equal(exitCode, 0, "test process failed");
  assert.equal(result?.success, true, "test reporter did not succeed");
  assert.equal(result.numFailedTestSuites, 0, "suite setup/teardown failed");
  assert.ok(Array.isArray(result.testResults) && result.testResults.length > 0 && result.testResults.length <= 256, "missing/bounded test files required");
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 }; let total = 0;
  for (const file of result.testResults) {
    assert.ok(Array.isArray(file.assertionResults), "missing test observations");
    assert.ok(file.status === "passed" || file.status === "skipped", "test file failed or did not complete");
    for (const item of file.assertionResults) {
      assert.ok(++total <= 10000, "test observation budget exceeded");
      assert.ok(typeof item.status === "string" && Object.hasOwn(testStates, item.status), "unknown/incomplete test result");
      counts[testStates[item.status]]++;
    }
  }
  assert.ok(counts.passed > 0 && counts.failed === 0, "no passing tests or an actual failure");
  assert.equal(result.numTotalTests, total, "inconsistent total test count");
  assert.equal(result.numPassedTests, counts.passed, "inconsistent passed count");
  assert.equal(result.numFailedTests, counts.failed, "inconsistent failed count");
  assert.equal(result.numPendingTests, counts.skipped, "inconsistent skipped count");
  if (result.numTodoTests !== undefined) assert.equal(result.numTodoTests, counts.todo, "inconsistent todo count");
  return { state: "passed", total, ...counts, files: result.testResults.length };
}

export function packageEvidence({ tests, source, artifact, platform, arch, node, elapsedMs }) {
  assert.equal(tests.state, "passed");
  assert.ok([tests.total, tests.passed, tests.failed, tests.skipped, tests.todo, tests.files].every(integer));
  assert.ok(tests.passed > 0 && tests.failed === 0 && tests.files > 0);
  assert.equal(tests.total, tests.passed + tests.failed + tests.skipped + tests.todo);
  assert.ok(artifact && hash(artifact.sha256) && integer(artifact.bytes) && artifact.bytes > 0);
  assert.ok(source && /^[a-f0-9]{40}$/u.test(source.commit) && /^[a-f0-9]{40}$/u.test(source.tree));
  assert.ok(["clean", "dirty"].includes(source.state));
  assert.ok(["linux", "darwin", "win32"].includes(platform));
  assert.ok(/^[A-Za-z0-9_-]{1,20}$/u.test(arch) && /^v[0-9.]+$/u.test(node)); assert.ok(integer(elapsedMs));
  return { schema_version: 1, evidence: "local_packaged_runner_e2e", attestation: "self_reported",
    source: { commit: source.commit, tree: source.tree, state: source.state },
    artifact: { sha256: artifact.sha256, bytes: artifact.bytes, signed: false, published: false },
    runtime: { platform, arch, node }, elapsed_ms: elapsedMs,
    tests: { state: "passed", total: tests.total, passed: tests.passed, failed: tests.failed, skipped: tests.skipped, todo: tests.todo, files: tests.files },
    signed_release: { state: "not_run" }, production: { state: "not_run" }, account_quotas: { state: "not_run" }, host_catalog: { state: "not_run" } };
}

const browserSources = ["ui-browser-check.mjs", "product-browser-check.mjs", "product-browser-fixture.mjs",
  "central-management-browser-check.mjs", "central-recovery-browser-check.mjs", "central-oauth-browser-check.mjs",
  "navigation-browser-check.mjs", "layout-browser-check.mjs", "runner-browser-check.mjs", "skill-upload-browser-check.mjs", "run-browser-e2e.mjs",
  "browser-worker-fixture.mjs", "worker-fixture.mjs", "run-e2e.mjs", "run-package-e2e.mjs"];
const browserOperations = ["Runtime.evaluate", "Page.navigate", "Page.getFrameTree", "Target.createTarget", "Target.attachToTarget",
  "Inspector.enable", "Page.enable", "Runtime.enable", "Network.enable", "Network.setCookies", "Network.setCookie", "Emulation.setDeviceMetricsOverride", "Browser.close"];
const failureKinds = [
  [/Browser startup timed out/u, "browser_startup_timeout"],
  [/Browser connection timed out/u, "browser_connection_timeout"],
  [/Browser connection closed/u, "browser_connection_closed"],
  [/Browser process exited/u, "browser_process_exited"],
  [/Browser process failed/u, "browser_process_failed"],
  [/Browser renderer crashed/u, "browser_renderer_crashed"],
  [/Browser target detached/u, "browser_target_detached"],
  [/Browser socket error/u, "browser_socket_error"],
  [/Browser request send failed/u, "browser_send_failed"],
  [/Browser protocol response invalid/u, "browser_protocol_invalid"],
  [/Browser closed/u, "browser_closed"],
  [/Browser navigation readiness timed out/u, "browser_navigation_timeout"],
  [/Browser operation timed out/u, "browser_operation_timeout"],
  [/Execution context was destroyed|Cannot find (?:default execution context|context with specified id)|Inspected target navigated or closed/u, "navigation_context_lost"],
  [/hook timed out|hook timeout/iu, "hook_timeout"], [/test timed out|test timeout/iu, "test_timeout"],
  [/ECONNREFUSED/u, "connection_refused"], [/fetch failed/iu, "fetch_failed"],
  [/timed? ?out|ETIMEDOUT/iu, "timeout"], [/AssertionError|assertion failed/iu, "assertion_failed"],
  [/EACCES|EPERM/u, "permission_denied"],
];

export function testFailureDetails(messages) {
  // Reporter messages can contain credentials and response bodies. Match bounded
  // input, then emit fixed labels and public source coordinates only.
  const text = stripVTControlCharacters((Array.isArray(messages) ? messages : [messages]).slice(0, 8)
    .filter(value => typeof value === "string").map(value => value.slice(0, 16384)).join("\n")).replaceAll("\\", "/");
  const toolResult = mcpToolResultFailureDiagnostic(text);
  // A diagnostic code such as "timeout" must not reclassify its assertion.
  const failureText = toolResult === undefined ? text : text.replace(/^RUNMESH_E2E_MCP_TOOL_RESULT_DIAGNOSTIC=.*$/gmu, "");
  const details = { kind: failureKinds.find(([pattern]) => pattern.test(failureText))?.[1] ?? "unclassified" };
  const httpStatus = /^(?:Error: )?RUNMESH_E2E_MCP_HTTP_STATUS=([1-5]\d{2})\r?$/mu.exec(text)?.[1];
  if (httpStatus !== undefined) {
    details.kind = "mcp_http_failure"; details.http_status = Number(httpStatus);
    const diagnostic = mcpHttpDiagnostic(text);
    if (diagnostic !== undefined) details.mcp_response = diagnostic;
  }
  const jobCompletion = jobCompletionDiagnostic(text);
  if (jobCompletion !== undefined) {
    if (httpStatus === undefined) details.kind = "job_completion_failure";
    details.job_completion = jobCompletion;
  }
  if (toolResult !== undefined) details.mcp_tool_result = toolResult;
  const source = /(?:^|[\s(/])((?:scripts\/[a-z0-9-]+\.mjs|test\/(?:e2e|browser)\/[a-z0-9.-]+\.ts)):(\d{1,7}):(\d{1,5})(?=$|[\s)])/gmu;
  for (const match of text.matchAll(source)) {
    if ((testFiles.includes(match[1]) || browserSources.some(name => match[1] === "scripts/" + name))
      && Number(match[2]) > 0 && Number(match[3]) > 0) {
      details.location = { file: match[1], line: Number(match[2]), column: Number(match[3]) }; break;
    }
  }
  const operation = /Browser operation timed out: ([A-Za-z.]+)(?=$|[\s)])/mu.exec(text)?.[1];
  if (details.kind === "browser_operation_timeout" && browserOperations.includes(operation)) details.operation = operation;
  const stage = /\(stage: ([a-z_]+)\)\r?$/mu.exec(text)?.[1];
  if (details.kind.startsWith("browser_") && UI_BROWSER_STAGES.includes(stage)) details.stage = stage;
  const navigationState = /^RUNMESH_E2E_UI_NAVIGATION_STATE=([a-z_]+) \(stage: [a-z_]+\)\r?$/mu.exec(text)?.[1];
  if (details.kind === "browser_navigation_timeout" && UI_BROWSER_NAVIGATION_STATES.includes(navigationState)) details.navigation_state = navigationState;
  const navigationDiagnostic = uiNavigationFailureDiagnostic(text);
  if (navigationDiagnostic !== undefined) details.navigation = navigationDiagnostic;
  return details;
}

export function testErrorDiagnostic(error) {
  const details = testFailureDetails([error?.message, error?.stack]);
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") details.kind = "output_limit_exceeded";
  else if (error?.killed === true) details.kind = "process_terminated";
  else if (Number.isSafeInteger(error?.code) && error.code >= 0) details.kind = "process_exit";
  else if (error?.code === "ERR_ASSERTION") details.kind = "assertion_failed";
  else if (error?.code === "ENOENT") details.kind = "file_or_command_missing";
  else if (["EACCES", "EPERM"].includes(error?.code)) details.kind = "permission_denied";
  else if (["ENOSPC", "EMFILE", "ENFILE", "ENOMEM"].includes(error?.code)) details.kind = "resource_exhausted";
  else if (error instanceof SyntaxError || error?.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
    || error?.message === "invalid_or_changed_evidence_file") details.kind = "invalid_evidence";
  return details;
}
