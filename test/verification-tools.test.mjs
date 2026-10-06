import { CI_CHECKS } from "../scripts/ci-contract.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { waitForWorker } from "../scripts/worker-fixture.mjs";
import { checkDomainImports, inventoryTests, validateTestPlan, validateTestWiring } from "../scripts/verification-plan.mjs";
import { summarizeVitest, packageEvidence } from "../scripts/test-evidence.mjs";
import { browserFailureEvidence, browserErrorDiagnostic, REQUIRED_BROWSER_TEST } from "../scripts/browser-evidence.mjs";
import { UI_BROWSER_STAGES, UI_BROWSER_NAVIGATION_STATES } from "../scripts/ui-browser-contract.mjs";
import { adminSetupHttpDiagnostic, createMcpWorkerDiagnosticForwarder, jobCompletionDiagnostic, mcpFixtureFailureDiagnostic, mcpHttpFailure, mcpHttpDiagnostic, mcpLauncherDiagnostic, mcpToolResultDiagnostic, mcpToolResultFailureDiagnostic, mcpWorkerFailureEvidence } from "../scripts/mcp-diagnostics.mjs";
import { renderExamples, renderFacts, validateExampleCoverage, verifyDocReferences } from "../scripts/project-facts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const plan = JSON.parse(await readFile(join(root, "test/verification-plan.json"), "utf8"));
const files = plan.groups.flatMap(g => g.files);

test("Worker fixture discovers its owned port over IPC after a released candidate is occupied", async t => {
  const candidate = createServer();
  await new Promise(resolve => candidate.listen(0, "127.0.0.1", resolve));
  const port = candidate.address().port;
  await new Promise(resolve => candidate.close(resolve));
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  // The old probe-close-spawn approach cannot claim this released address.
  const oldLaunch = createServer();
  await assert.rejects(new Promise((resolve, reject) => {
    oldLaunch.once("error", reject); oldLaunch.listen(port, "127.0.0.1", resolve);
  }), { code: "EADDRINUSE" });

  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from 'node:http';
    const server = createServer((_request, response) => response.end('healthy'));
    server.listen(0, '127.0.0.1', () => process.send(JSON.stringify({
      event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: server.address().port
    })));
  `], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
  });
  const origin = await waitForWorker(child, 5_000);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
  assert.notEqual(Number(new URL(origin).port), port);
  assert.equal(child.listenerCount("message"), 0);
});

test("Worker fixture fails promptly if the launcher exits before its readiness message", async () => {
  for (const alreadyExited of [false, true]) {
    const child = new ChildProcess();
    if (alreadyExited) child.exitCode = 1;
    const ready = waitForWorker(child, 60_000, () => "launcher failed");
    if (!alreadyExited) { child.exitCode = 1; child.emit("exit", 1, null); }
    await assert.rejects(ready, /Worker exited before readiness \(code=1, signal=null\)\nlauncher failed/);
    for (const event of ["message", "error", "exit"]) assert.equal(child.listenerCount(event), 0);
  }
});

test("Worker fixture rejects spawn errors and malformed readiness addresses", async () => {
  const child = new ChildProcess();
  const failed = waitForWorker(child, 60_000);
  child.emit("error", new Error("synthetic spawn failure"));
  await assert.rejects(failed, /Worker failed to start: synthetic spawn failure/);
  for (const address of [{ ip: "127.0.0.1", port: 0 }, { ip: "example.com", port: 80 }, { ip: "127.0.0.1", port: 70_000 }]) {
    const ready = waitForWorker(child, 60_000);
    child.emit("message", JSON.stringify({ event: "DEV_SERVER_READY", ...address }));
    await assert.rejects(ready, /invalid loopback readiness address/);
  }
});

for (const failure of ["deadline", "exit"]) {
  test(`Worker fixture cancels an accepted stalled health request on ${failure}`, async t => {
    const child = new ChildProcess();
    let disconnected;
    const closed = new Promise(resolve => { disconnected = resolve; });
    const server = createServer((_request, response) => {
      response.once("close", disconnected);
      if (failure === "exit") { child.exitCode = 1; child.emit("exit", 1, null); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const ready = waitForWorker(child, failure === "deadline" ? 1_000 : 60_000, () => "health probe stalled");
    child.emit("message", JSON.stringify({ event: "DEV_SERVER_READY", ip: "127.0.0.1", port: server.address().port }));
    await assert.rejects(ready, failure === "deadline" ? /timed out after 1000ms\nhealth probe stalled/ : /Worker exited before readiness/);
    await closed;
    assert.equal(child.listenerCount("message"), 0);
  });
}

test("format gate discovers every supported script extension in the Git index", async t => {
  const dir = await mkdtemp(join(tmpdir(), "runmesh-format-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: dir }).status, 0);
  const run = () => spawnSync(process.execPath, [join(root, "scripts/check-format.mjs")], { cwd: dir, encoding: "utf8", timeout: 10000 });
  for (const extension of ["ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx"]) {
    const name = "browser." + extension;
    await writeFile(join(dir, name), "export {};  \n");
    assert.equal(spawnSync("git", ["add", "--", name], { cwd: dir }).status, 0);
    const rejected = run();
    assert.equal(rejected.status, 1, name + ": " + rejected.stdout);
    assert.ok(rejected.stderr.includes(name + ":1: trailing whitespace"));
    await writeFile(join(dir, name), "export {};\n");
    assert.equal(run().status, 0);
  }
});

test("format gate reads quoted Git paths and untracked browser sources", async t => {
  const dir = await mkdtemp(join(tmpdir(), "runmesh-format-paths-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: dir }).status, 0);
  assert.equal(spawnSync("git", ["config", "core.quotePath", "true"], { cwd: dir }).status, 0);
  const name = "中文 source.ts", path = join(dir, name);
  const run = () => spawnSync(process.execPath, [join(root, "scripts/check-format.mjs")], { cwd: dir, encoding: "utf8", timeout: 10000 });
  await writeFile(path, "export {};  \n");
  assert.equal(spawnSync("git", ["add", "--", name], { cwd: dir }).status, 0);
  const unicode = run();
  assert.equal(unicode.status, 1);
  assert.ok(unicode.stderr.includes(name + ":1: trailing whitespace"));
  await writeFile(path, "export {};\r\n");
  assert.equal(run().status, 0, "Windows CRLF remains supported");
  await rm(path);
  assert.equal(run().status, 0, "Deleting an indexed file is a valid change");
  await writeFile(join(dir, "new browser.js"), "export {}; ");
  const untracked = run();
  assert.equal(untracked.status, 1);
  assert.ok(untracked.stderr.includes("new browser.js: missing final newline"));
  await writeFile(join(dir, "new browser.js"), Buffer.from([0xff, 0x0a]));
  assert.ok(run().stderr.includes("new browser.js: invalid UTF-8"));
});

test("failed browser diagnostics retain status counts without copying private reporter values", () => {
  const summary = browserFailureEvidence({ testResults: [{ name: "/private/source", assertionResults: [
    { title: REQUIRED_BROWSER_TEST, status: "failed", failureMessages: ["cookie=private-token"] },
    { title: "private fixture", status: "passed", failureMessages: ["private stdout"] },
    { status: "pending" },
  ] }] });
  assert.deepEqual(summary, { report_available: true, required_browser_checks: 1, required_browser_status: "failed", failed_tests: 1, skipped_tests: 1,
    failures: [{ test_index: 1, required_browser_check: true, kind: "unclassified" }], truncated: false });
  assert.ok(!JSON.stringify(summary).includes("private"));
  assert.deepEqual(browserFailureEvidence(undefined), { report_available: false });
  assert.equal(browserFailureEvidence({ testResults: [{ assertionResults: [{ title: REQUIRED_BROWSER_TEST, status: "private-token" }] }] }).required_browser_status, "unknown");
});

test("browser failure messages preserve the failing assertion location without its values or absolute path", () => {
  const raw = { testResults: [{ assertionResults: [{ title: REQUIRED_BROWSER_TEST, status: "failed", failureMessages: [
    "AssertionError [ERR_ASSERTION]: Expected private-cookie to equal private-token\n    at checkUiWithChromium (/private/build/scripts/ui-browser-check.mjs:63:17)\n    at /private/build/test/e2e/mcp-runner.e2e.test.ts:597:5",
  ] }] }] };
  const summary = browserFailureEvidence(raw);
  assert.deepEqual(summary.failures, [{ test_index: 1, required_browser_check: true, kind: "assertion_failed",
    location: { file: "scripts/ui-browser-check.mjs", line: 63, column: 17 } }]);
  assert.ok(!JSON.stringify(summary).includes("private"));
});

test("browser diagnostic classes distinguish navigation, startup, operation and test timeouts", () => {
  for (const [message, kind] of [
    ["Browser startup timed out", "browser_startup_timeout"],
    ["Browser navigation readiness timed out after 5000 ms", "browser_navigation_timeout"],
    ["Execution context was destroyed.", "navigation_context_lost"],
    ["Cannot find context with specified id", "navigation_context_lost"],
    ["Test timed out in 45000ms", "test_timeout"], ["Hook timed out in 30000ms", "hook_timeout"],
  ]) assert.equal(browserErrorDiagnostic(new Error(message + " private-cookie")).kind, kind);
  assert.deepEqual(browserErrorDiagnostic(new Error("Browser operation timed out: Runtime.evaluate\nprivate-token")),
    { kind: "browser_operation_timeout", operation: "Runtime.evaluate" });
  assert.deepEqual(browserErrorDiagnostic(new Error("Browser operation timed out: private.token")), { kind: "browser_operation_timeout" });
  assert.equal(browserErrorDiagnostic({ code: -32000, message: "Execution context was destroyed." }).kind, "navigation_context_lost");
});

test("colored browser failure stacks retain safe assertion locations", () => {
  const summary = browserFailureEvidence({ testResults: [{ assertionResults: [{ title: REQUIRED_BROWSER_TEST, status: "failed", failureMessages: [
    "\u001b[31mAssertionError\u001b[39m: private-cookie\n    at check (\u001b[36m/private/build/scripts/ui-browser-check.mjs\u001b[39m:\u001b[33m63:17\u001b[39m)",
  ] }] }] });
  assert.deepEqual(summary.failures, [{ test_index: 1, required_browser_check: true, kind: "assertion_failed",
    location: { file: "scripts/ui-browser-check.mjs", line: 63, column: 17 } }]);
  assert.ok(!JSON.stringify(summary).includes("private"));
});

test("browser stages retain only shared fixed labels from complete diagnostic markers", () => {
  for (const stage of UI_BROWSER_STAGES) {
    const error = new Error(`Browser operation timed out: Runtime.evaluate (stage: ${stage})`);
    assert.deepEqual(browserErrorDiagnostic(error), { kind: "browser_operation_timeout", operation: "Runtime.evaluate", stage });
  }
  for (const stage of ["private_token", "dashboard_initial?private-token", "dashboard_initial private-token", "dashboard_initial/secret", ""])
    assert.deepEqual(browserErrorDiagnostic({ message: `Browser operation timed out: Runtime.evaluate (stage: ${stage})` }),
      { kind: "browser_operation_timeout", operation: "Runtime.evaluate" });
  for (const message of ["private-token (stage: dashboard_initial)", "Browser closed (stage: dashboard_initial)private-token"])
    assert.equal(browserErrorDiagnostic({ message }).stage, undefined);
});

test("browser lifecycle summaries keep classified stages without private failure payloads", () => {
  for (const [message, kind] of [
    ["Browser connection timed out", "browser_connection_timeout"], ["Browser connection closed", "browser_connection_closed"],
    ["Browser process exited", "browser_process_exited"], ["Browser process failed", "browser_process_failed"],
    ["Browser renderer crashed", "browser_renderer_crashed"], ["Browser target detached", "browser_target_detached"],
    ["Browser socket error", "browser_socket_error"], ["Browser request send failed", "browser_send_failed"],
    ["Browser protocol response invalid", "browser_protocol_invalid"], ["Browser closed", "browser_closed"],
  ]) {
    const summary = browserFailureEvidence({ testResults: [{ assertionResults: [{ title: REQUIRED_BROWSER_TEST, status: "failed",
      failureMessages: [`Error: ${message} (stage: dashboard_initial)\nprivate-cookie private-expression`],
    }] }] });
    assert.deepEqual(summary.failures, [{ test_index: 1, required_browser_check: true, kind, stage: "dashboard_initial" }]);
    assert.ok(!JSON.stringify(summary).includes("private"));
  }
});

test("browser navigation diagnostics retain only complete fixed condition markers", () => {
  for (const state of UI_BROWSER_NAVIGATION_STATES) {
    const summary = browserFailureEvidence({ testResults: [{ assertionResults: [{ title: REQUIRED_BROWSER_TEST, status: "failed",
      failureMessages: [`Browser navigation readiness timed out after 5000 ms\nRUNMESH_E2E_UI_NAVIGATION_STATE=${state} (stage: clients_navigation)\nprivate-cookie private-response`],
    }] }] });
    assert.deepEqual(summary.failures, [{ test_index: 1, required_browser_check: true, kind: "browser_navigation_timeout", stage: "clients_navigation", navigation_state: state }]);
    assert.doesNotMatch(JSON.stringify(summary), /private/u);
  }
  for (const marker of ["private_token", "navigation_busy?private-token", "navigation_busy private-token", "navigation_busy/secret", ""])
    assert.equal(browserErrorDiagnostic({ message: `Browser navigation readiness timed out\nRUNMESH_E2E_UI_NAVIGATION_STATE=${marker} (stage: clients_navigation)` }).navigation_state, undefined);
  for (const message of ["private-response\nRUNMESH_E2E_UI_NAVIGATION_STATE=navigation_busy (stage: clients_navigation)",
    "Browser navigation readiness timed out\nprivate-response RUNMESH_E2E_UI_NAVIGATION_STATE=navigation_busy (stage: clients_navigation)",
    "Browser navigation readiness timed out\nRUNMESH_E2E_UI_NAVIGATION_STATE=navigation_busy (stage: clients_navigation)private-response"])
    assert.equal(browserErrorDiagnostic({ message }).navigation_state, undefined);
});

test("admin setup response diagnostics retain fixed stages and runtime signatures without response content", async () => {
  for (const stage of ["runner_permissions", "workspace_create", "readonly_workspace_create", "context_workspace_create", "private-stage"]) {
    const response = new Response("Error: Network connection lost.\n at https://private-token/admin", {
      status: 500, headers: { "content-type": "text/plain; private=header", "set-cookie": "private-cookie", location: "https://private-location" },
    });
    const diagnostic = await adminSetupHttpDiagnostic(response, stage);
    assert.equal(diagnostic, "RUNMESH_E2E_ADMIN_SETUP_DIAGNOSTIC=" + JSON.stringify({
      stage: stage === "private-stage" ? "other" : stage, status: 500, content_type: "text", body_kind: "present", runtime_signature: "network_connection_lost",
    }));
    assert.ok(!diagnostic.includes("private"));
  }
  const html = await adminSetupHttpDiagnostic(new Response("<html>private-body Error: Network connection lost.</html>", {
    status: 503, headers: { "content-type": "text/html" },
  }), "runner_permissions");
  assert.equal(html, 'RUNMESH_E2E_ADMIN_SETUP_DIAGNOSTIC={"stage":"runner_permissions","status":503,"content_type":"html","body_kind":"present"}');
});

test("admin setup diagnostics bound response inspection without retrying the mutation", async () => {
  let cancelled = false;
  const stalled = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 500 });
  const result = await adminSetupHttpDiagnostic(stalled, "runner_permissions");
  assert.equal(result, 'RUNMESH_E2E_ADMIN_SETUP_DIAGNOSTIC={"stage":"runner_permissions","status":500,"content_type":"absent","body_kind":"read_timeout"}');
  assert.equal(cancelled, true);
  const oversized = await adminSetupHttpDiagnostic(new Response("private".repeat(1000), { status: 500 }), "workspace_create");
  assert.ok(oversized.includes('"body_kind":"oversized"'));
  assert.ok(!oversized.includes("private"));
});

test("MCP tool-result diagnostics carry known classifications without inspecting free-form tool content", () => {
  for (const code of ["search_snapshot_changed", "timeout", "runner_rpc_failed", "tool_result_invalid", "invalid_params", "runner_offline"]) {
    const result = { isError: true, structuredContent: { error: { code, failure_class: "conflict", operation_state: "not_started", next_action: "re_read_and_retry",
      message: "private-error", recovery_hint: "private-hint", details: { path: "private-path", snapshot_id: "private-id" } }, runner_id: "private-runner" } };
    Object.defineProperty(result, "content", { get() { assert.fail("Free-form tool content must not be inspected"); } });
    const marker = mcpToolResultDiagnostic("inspect_search_continuation", result);
    const detail = { phase: "inspect_search_continuation", result: "error", error_code: code,
      failure_class: "conflict", operation_state: "not_started", next_action: "re_read_and_retry" };
    assert.deepEqual(mcpToolResultFailureDiagnostic(marker), detail);
    const failure = browserFailureEvidence({ testResults: [{ assertionResults: [{ status: "failed", failureMessages: [
      "AssertionError: " + marker + ": expected true to not be true",
    ] }] }] });
    assert.deepEqual(failure.failures, [{ test_index: 1, required_browser_check: false, kind: "assertion_failed", mcp_tool_result: detail }]);
    assert.deepEqual(browserErrorDiagnostic(new Error("Operation timed out" + marker)), { kind: "timeout", mcp_tool_result: detail });
    assert.ok(!marker.includes("private"));
    assert.ok(!JSON.stringify(failure).includes("private"));
  }
});

test("MCP tool-result diagnostics normalize unknown, missing and malformed result fields", () => {
  const missing = { phase: "inspect_search_initial", result: "absent", error_code: "absent", failure_class: "absent", operation_state: "absent", next_action: "absent" };
  assert.deepEqual(mcpToolResultFailureDiagnostic(mcpToolResultDiagnostic("inspect_search_initial", {})), missing);
  assert.deepEqual(mcpToolResultFailureDiagnostic(mcpToolResultDiagnostic("inspect_search_initial", null)), missing);
  for (const value of ["private-value", "__proto__", "constructor", ["timeout"], null, 0, true, {}]) {
    const marker = mcpToolResultDiagnostic(value, { isError: value, structuredContent: { error: {
      code: value, failure_class: value, operation_state: value, next_action: value,
    } } });
    assert.deepEqual(mcpToolResultFailureDiagnostic(marker), { phase: "other", result: value === true ? "error" : "other",
      error_code: "other", failure_class: "other", operation_state: "other", next_action: "other" });
    assert.ok(!marker.includes("private"));
  }
  const malformed = mcpToolResultDiagnostic("inspect_search_initial", { isError: false, structuredContent: { error: "private-error" } });
  assert.deepEqual(mcpToolResultFailureDiagnostic(malformed), { phase: "inspect_search_initial", result: "success", error_code: "other",
    failure_class: "other", operation_state: "other", next_action: "other" });
});

test("MCP tool-result decoder projects a bounded enum record and rejects forged fields and marker lines", () => {
  const detail = { phase: "inspect_search_initial", result: "error", error_code: "timeout", failure_class: "availability", operation_state: "unknown", next_action: "inspect_job" };
  const marker = value => "RUNMESH_E2E_MCP_TOOL_RESULT_DIAGNOSTIC=" + JSON.stringify(value);
  assert.deepEqual(mcpToolResultFailureDiagnostic(marker({ ...detail, path: "private-path", args: "private-args", id: "private-id" })), detail);
  for (const key of Object.keys(detail)) {
    for (const value of ["private", [detail[key]], null, {}, 1, true])
      assert.equal(mcpToolResultFailureDiagnostic(marker({ ...detail, [key]: value })), undefined);
    const missing = { ...detail }; delete missing[key];
    assert.equal(mcpToolResultFailureDiagnostic(marker(missing)), undefined);
  }
  for (const text of [undefined, {}, marker([]), marker(null), "private " + marker(detail), marker(detail) + "private", marker({ ...detail, private: "x".repeat(513) })])
    assert.equal(mcpToolResultFailureDiagnostic(text), undefined);
  assert.equal(mcpToolResultFailureDiagnostic("RUNMESH_E2E_MCP_TOOL_RESULT_DIAGNOSTIC={invalid}"), undefined);
});

test("MCP tool-result failure evidence preserves safe fields and the original assertion coordinates", () => {
  const diagnostic = { phase: "inspect_search_continuation", result: "error", error_code: "search_snapshot_changed",
    failure_class: "conflict", operation_state: "not_started", next_action: "re_read_and_retry" };
  const summary = browserFailureEvidence({ testResults: [{ assertionResults: [{ status: "failed", failureMessages: [
    "AssertionError: \nRUNMESH_E2E_MCP_TOOL_RESULT_DIAGNOSTIC=" + JSON.stringify(diagnostic)
      + "\n: expected true to not be true\n    at /private/test/e2e/mcp-runner.e2e.test.ts:566:32",
  ] }] }] });
  assert.deepEqual(summary.failures, [{ test_index: 1, required_browser_check: false, kind: "assertion_failed", mcp_tool_result: diagnostic,
    location: { file: "test/e2e/mcp-runner.e2e.test.ts", line: 566, column: 32 } }]);
  assert.ok(!JSON.stringify(summary).includes("private"));
});

test("MCP HTTP failures retain only a bounded status from the exact fixed marker", () => {
  for (const status of [100, 429, 502, 503, 599]) {
    const summary = browserFailureEvidence({ testResults: [{ assertionResults: [{ status: "failed", failureMessages: [
      `\u001b[31mError: RUNMESH_E2E_MCP_HTTP_STATUS=${status}\u001b[39m\r\n    at mcpMessage (/private/test/e2e/mcp-runner.e2e.test.ts:1001:13)\nprivate-cookie private-response`,
    ] }] }] });
    assert.deepEqual(summary.failures, [{ test_index: 1, required_browser_check: false, kind: "mcp_http_failure", http_status: status,
      location: { file: "test/e2e/mcp-runner.e2e.test.ts", line: 1001, column: 13 } }]);
    assert.ok(!JSON.stringify(summary).includes("private"));
  }
  assert.deepEqual(browserErrorDiagnostic(new Error("RUNMESH_E2E_MCP_HTTP_STATUS=503")), { kind: "mcp_http_failure", http_status: 503 });
  for (const marker of ["99", "600", "0503", "5030", "503.1", "503 private-token", "503?cookie=private-token", "private-response"])
    assert.deepEqual(browserErrorDiagnostic({ message: "RUNMESH_E2E_MCP_HTTP_STATUS=" + marker }), { kind: "unclassified" });
  assert.deepEqual(browserErrorDiagnostic({ message: "private-response RUNMESH_E2E_MCP_HTTP_STATUS=503" }), { kind: "unclassified" });
});

test("MCP HTTP response evidence retains fixed RPC classifications and the read phase", async () => {
  for (const [id, rpc_id] of [[123, "matches"], [null, "null"], ["private-id", "other"], [undefined, "absent"]]) {
    const response = Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: "private-token" }, private: "private-body" }, { status: 500 });
    const error = await mcpHttpFailure(response, 123, "read", { cursor: "private-cursor", path: "private-path" });
    const diagnostic = { content_type: "json", phase: "read_continuation", body_kind: "json_rpc_error", rpc_code: -32603, rpc_id };
    assert.deepEqual(browserErrorDiagnostic(error), { kind: "mcp_http_failure", http_status: 500, mcp_response: diagnostic });
    assert.ok(!JSON.stringify(browserErrorDiagnostic(error)).includes("private"));
    assert.ok(!error.message.includes("private"));
  }
  for (const code of [-32700, -32600, -32601, -32602, -32000, -32999]) {
    const error = await mcpHttpFailure(Response.json({ jsonrpc: "2.0", id: 123, error: { code, message: "private" } }, { status: 500 }), 123, "read", {});
    assert.equal(browserErrorDiagnostic(error).mcp_response.rpc_code, code === -32999 ? "other" : code);
    assert.equal(browserErrorDiagnostic(error).mcp_response.phase, "read_initial");
  }
});

test("MCP HTTP classification does not publish custom media types, IDs, bodies or malformed RPC fields", async () => {
  for (const [type, body, content_type, body_kind] of [
    ["text/html", "<p>private-token</p>", "html", "non_json"], ["text/plain", "private", "text", "non_json"],
    ["text/event-stream", "data: private\n\n", "sse", "non_json"], ["application/private-token", "private", "other", "non_json"],
    ["application/json", "{private", "json", "invalid_json"], ["application/json", "null", "json", "not_rpc_error"],
    ["application/json", '{"jsonrpc":"2.0","id":"private","error":{"code":"private","message":"private"}}', "json", "not_rpc_error"],
    ["application/json", '{"jsonrpc":"2.0","id":"private","error":{"code":-32603}}', "json", "not_rpc_error"],
  ]) {
    const error = await mcpHttpFailure(new Response(body, { status: 500, headers: { "content-type": type } }), 123, "private-tool", { path: "private" });
    assert.deepEqual(browserErrorDiagnostic(error).mcp_response, { content_type, phase: "other", body_kind, rpc_code: "absent", rpc_id: "absent" });
    assert.ok(!error.message.includes("private"));
  }
  const empty = await mcpHttpFailure(new Response(null, { status: 500 }), 1, "read", {});
  assert.deepEqual(browserErrorDiagnostic(empty).mcp_response, { content_type: "absent", phase: "read_initial", body_kind: "empty", rpc_code: "absent", rpc_id: "absent" });
});

test("MCP queued-command failure phases distinguish each operation without arguments", async () => {
  for (const [name, args, phase] of [
    ["runner_select", { runner_id: "private-runner" }, "runner_select"],
    ["shell", { command: "private-command" }, "shell"],
    ["edit", { patch: "private-patch" }, "edit"],
    ["job", { action: "get", job_id: "private-job" }, "job_get"],
    ["job", { action: "logs", cursor: "private-cursor" }, "job_logs"],
    ["job", { action: "cancel", job_id: "private-job" }, "job_cancel"],
    ["job", { action: "private-action" }, "other"],
    ["private-tool", { action: "cancel" }, "other"],
  ]) {
    const error = await mcpHttpFailure(new Response("private-body", { status: 500 }), 123, name, args);
    assert.equal(browserErrorDiagnostic(error).mcp_response.phase, phase);
    assert.ok(!error.message.includes("private"));
  }
});

test("MCP text failures preserve fixed runtime signatures without publishing a stack", async () => {
  for (const [runtime_signature, text] of [
    ["network_connection_lost", "Network connection lost."],
    ["cross_request_io", "Cannot perform I/O on behalf of a different request."],
    ["cross_request_promise", "A promise was resolved or rejected from a different request context than the one it was created in."],
    ["hung_request", "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response."],
    ["locked_reader", "This ReadableStream is locked to a reader."],
  ]) {
    const prefix = runtime_signature === "locked_reader" ? "TypeError: " : "Error: ";
    const error = await mcpHttpFailure(new Response(`${prefix}${text}\n at https://private-token/mcp:1:2`, { status: 500 }), 123, "job", { action: "get" });
    const evidence = browserErrorDiagnostic(error).mcp_response;
    assert.equal(evidence.runtime_signature, runtime_signature);
    assert.equal(evidence.phase, "job_get");
    assert.equal(evidence.body_kind, "non_json");
    assert.ok(!error.message.includes("private"));
    assert.equal(mcpHttpDiagnostic("RUNMESH_E2E_MCP_HTTP_DIAGNOSTIC=" + JSON.stringify({ ...evidence, runtime_signature: "private-error" })), undefined);
  }
  const unknown = await mcpHttpFailure(new Response("Error: private-error", { status: 500 }), 1, "shell", {});
  assert.equal(browserErrorDiagnostic(unknown).mcp_response.runtime_signature, undefined);
});

test("MCP error body diagnostics bound bytes, chunks and stalled reads without waiting for cancellation", async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4097)); },
    cancel() { cancelled++; return new Promise(() => {}); } }), { status: 500 });
  assert.equal(browserErrorDiagnostic(await mcpHttpFailure(response, 1, "read", {})).mcp_response.body_kind, "oversized");
  assert.equal(cancelled, 1);
  const stalled = new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }), { status: 503 });
  assert.equal(browserErrorDiagnostic(await mcpHttpFailure(stalled, 1, "read", {})).mcp_response.body_kind, "read_timeout");
  assert.equal(cancelled, 2);
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error("private-error")); } }), { status: 500 });
  assert.equal(browserErrorDiagnostic(await mcpHttpFailure(broken, 1, "read", {})).mcp_response.body_kind, "read_error");
  const invalid = new Response(new Uint8Array([0xff]), { status: 500, headers: { "content-type": "application/json" } });
  assert.equal(browserErrorDiagnostic(await mcpHttpFailure(invalid, 1, "read", {})).mcp_response.body_kind, "invalid_json");
  let pulled = 0;
  const emptyChunks = new Response(new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array()); } }), { status: 500 });
  const emptyOutcome = browserErrorDiagnostic(await mcpHttpFailure(emptyChunks, 1, "read", {})).mcp_response.body_kind;
  // Either existing bound can stop a stream of empty chunks first; CPU speed
  // must not decide whether the diagnostic test passes.
  assert.ok(["oversized", "read_timeout"].includes(emptyOutcome));
  assert.ok(pulled <= 4098);
});

test("MCP safe summaries validate every classification and never copy additional fields", () => {
  const value = { content_type: "json", phase: "read_initial", body_kind: "json_rpc_error", rpc_code: -32603, rpc_id: "matches" };
  const marker = data => "RUNMESH_E2E_MCP_HTTP_DIAGNOSTIC=" + JSON.stringify(data);
  assert.deepEqual(mcpHttpDiagnostic(marker({ ...value, private: "private" })), value);
  for (const key of Object.keys(value)) assert.equal(mcpHttpDiagnostic(marker({ ...value, [key]: "private" })), undefined);
  assert.equal(mcpHttpDiagnostic("private " + marker(value)), undefined);
  assert.equal(mcpHttpDiagnostic(marker(value) + "private"), undefined);
  assert.equal(mcpHttpDiagnostic(marker({ ...value, private: "x".repeat(513) })), undefined);
  const summary = browserFailureEvidence({ testResults: [{ assertionResults: [{ status: "failed", failureMessages: [
    "Error: RUNMESH_E2E_MCP_HTTP_STATUS=500\n" + marker({ ...value, private: "private" }),
  ] }] }] });
  assert.deepEqual(summary.failures, [{ test_index: 1, required_browser_check: false, kind: "mcp_http_failure", http_status: 500, mcp_response: value }]);
});

test("Job completion evidence distinguishes terminal failures from timeouts without private fields", () => {
  const marker = value => "RUNMESH_E2E_JOB_COMPLETION_DIAGNOSTIC=" + JSON.stringify(value);
  for (const value of [
    { outcome: "timeout", status: "running", exit_code: null },
    { outcome: "terminal_failure", status: "failed", exit_code: 1 },
    { outcome: "tool_error", status: "absent", exit_code: null },
  ]) {
    const text = "Job did not complete successfully\n" + marker({ ...value, command: "private-command", job_id: "private-job" });
    assert.deepEqual(jobCompletionDiagnostic(text), value);
    assert.deepEqual(browserErrorDiagnostic(new Error(text)), { kind: "job_completion_failure", job_completion: value });
    assert.ok(!JSON.stringify(browserErrorDiagnostic(new Error(text))).includes("private"));
  }
  const valid = { outcome: "timeout", status: "running", exit_code: null };
  for (const patch of [
    { outcome: "private" }, { status: "private" }, { exit_code: "private" }, { exit_code: 0.5 },
    { exit_code: 2147483648 }, { exit_code: -2147483649 },
  ]) assert.equal(jobCompletionDiagnostic(marker({ ...valid, ...patch })), undefined);
  assert.equal(jobCompletionDiagnostic("private " + marker(valid)), undefined);
  assert.equal(jobCompletionDiagnostic(marker(valid) + "private"), undefined);
  assert.equal(jobCompletionDiagnostic(marker({ ...valid, private: "x".repeat(257) })), undefined);
});

test("MCP Worker diagnostics cross fragmented process output into the final safe evidence", () => {
  const emitted = [], forward = createMcpWorkerDiagnosticForwarder(line => emitted.push(line));
  forward("private-token\n\u001b[33m[WARNING]\u001b[0m RUNMESH_MCP_HANDLER_ERROR kind=type_");
  forward("error stage=server_factory reason=unknown\r\nprivate-cookie\n");
  forward("RUNMESH_MCP_HANDLER_ERROR kind=error stage=sdk_transport reason=unknown\n");
  const expected = [{ event: "mcp_handler_error", kind: "type_error", stage: "server_factory", reason: "unknown" },
    { event: "mcp_handler_error", kind: "error", stage: "sdk_transport", reason: "unknown" }];
  assert.deepEqual(mcpWorkerFailureEvidence("private stderr\n" + emitted.join("") + "x".repeat(70000)), expected);
  assert.ok(!emitted.join("").includes("private"));
  assert.equal(emitted.length, 2);
});

test("MCP outer-boundary diagnostics retain fixed stages through the CI evidence projection", () => {
  const stages = ["request_validation", "identity_verification", "request_body", "module_loading", "provider_setup", "response_priming", "response_headers"];
  const emitted = [], forward = createMcpWorkerDiagnosticForwarder(line => emitted.push(line));
  for (const stage of stages) forward(`RUNMESH_MCP_HANDLER_ERROR kind=error stage=${stage} reason=network_connection_lost\n`);
  const expected = stages.map(stage => ({ event: "mcp_handler_error", kind: "error", stage, reason: "network_connection_lost" }));
  assert.deepEqual(mcpWorkerFailureEvidence(emitted.join("")), expected);
  assert.ok(!emitted.join("").includes("Network connection lost."));
  forward("RUNMESH_MCP_HANDLER_ERROR kind=error stage=private-token reason=network_connection_lost\n");
  forward("RUNMESH_MCP_HANDLER_ERROR kind=error stage=request_body reason=network_connection_lost_private-token\n");
  assert.deepEqual(mcpWorkerFailureEvidence(emitted.join("")), expected);
});

test("MCP Worker diagnostics accept the observed Wrangler warning prefix without accepting arbitrary prefixes", () => {
  const emitted = [], forward = createMcpWorkerDiagnosticForwarder(line => emitted.push(line));
  const marker = "RUNMESH_MCP_HANDLER_ERROR kind=error stage=sdk_transport reason=unknown\n";
  // Observed from the pinned Wrangler CLI: U+25B2, space, [WARNING], space.
  forward("\u001b[33m\u25b2 [WARNING]\u001b[0m " + marker);
  for (const prefix of ["private ", "\u25b2 private [WARNING] ", "\u25b2 [private] ", "\u25b2 [ERROR] "]) forward(prefix + marker);
  assert.equal(emitted.length, 1);
  assert.deepEqual(mcpWorkerFailureEvidence(emitted.join("")), [{ event: "mcp_handler_error", kind: "error", stage: "sdk_transport", reason: "unknown" }]);
});

test("MCP Worker diagnostics reject partial, oversized and private event fields and cap output", () => {
  const emitted = [], forward = createMcpWorkerDiagnosticForwarder(line => emitted.push(line));
  for (const line of ["private RUNMESH_MCP_HANDLER_ERROR kind=error stage=sdk_transport reason=unknown\n",
    "RUNMESH_MCP_HANDLER_ERROR kind=private stage=sdk_transport reason=unknown\n", "RUNMESH_MCP_HANDLER_ERROR kind=error stage=private\n",
    "RUNMESH_MCP_HANDLER_ERROR kind=error stage=sdk_transport reason=unknown private\n", "x".repeat(1025)]) forward(line);
  forward("RUNMESH_MCP_HANDLER_ERROR kind=error stage=sdk_transport reason=unknown\n");
  assert.deepEqual(emitted, []);
  for (let index = 0; index < 30; index++) forward("RUNMESH_MCP_HANDLER_ERROR kind=error stage=sdk_transport reason=unknown\n");
  assert.equal(emitted.length, 16);
  assert.equal(mcpWorkerFailureEvidence(emitted.join("").repeat(3)).length, 16);
  for (const value of [{ event: "private", kind: "error", stage: "sdk_transport", reason: "unknown" }, { event: "mcp_handler_error", kind: "private", stage: "sdk_transport", reason: "unknown" },
    { event: "mcp_handler_error", kind: "error", stage: "private", reason: "unknown" }, { event: "mcp_handler_error", kind: "error", stage: "sdk_transport", reason: "private" }])
    assert.deepEqual(mcpWorkerFailureEvidence("RUNMESH_E2E_MCP_WORKER_EVENT=" + JSON.stringify(value) + "\n"), []);
});

test("a failed E2E subprocess preserves only forwarded Worker events in its CI summary", () => {
  const helper = new URL("../scripts/mcp-diagnostics.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createMcpWorkerDiagnosticForwarder } from ${JSON.stringify(helper)};
    const forward = createMcpWorkerDiagnosticForwarder(line => process.stderr.write(line));
    forward("private worker output\\nRUNMESH_MCP_HANDLER_ERROR kind=type_error stage=server_factory reason=unknown\\n");
    process.stderr.write("private assertion details\\n");
    process.exitCode = 1;
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 1);
  const summary = { error: browserErrorDiagnostic({ code: child.status }), worker_events: mcpWorkerFailureEvidence(child.stderr) };
  assert.deepEqual(summary, { error: { kind: "process_exit" }, worker_events: [{ event: "mcp_handler_error", kind: "type_error", stage: "server_factory", reason: "unknown" }] });
  assert.ok(!JSON.stringify(summary).includes("private"));
});

test("fixed runtime messages survive fragmented Worker logs without copying text or prefixes", () => {
  const emitted = [], forward = createMcpWorkerDiagnosticForwarder(line => emitted.push(line));
  forward("\u001b[31m\u2718 [ERROR]\u001b[0m Error: Network connec");
  forward("tion lost.\r\n  at private-stack\n");
  forward("[ERROR] Cannot perform I/O on behalf of a different request.\n");
  forward("Error: This ReadableStream is locked to a reader.\n");
  for (const line of ["private Network connection lost.\n", "Error: Network connection lost. private-token\n", "[PRIVATE] Network connection lost.\n", "x".repeat(1025) + "\n"])
    forward(line);
  assert.deepEqual(mcpWorkerFailureEvidence(emitted.join("")), [
    { event: "runtime_log", signature: "network_connection_lost" },
    { event: "runtime_log", signature: "cross_request_io" },
    { event: "runtime_log", signature: "locked_reader" },
  ]);
  assert.doesNotMatch(emitted.join(""), /private|Network connection|ReadableStream/u);
});

test("launcher snapshots report only lifecycle classification and bounded exit state", () => {
  const expected = { event: "launcher_snapshot", reason: "test_failed", exit_code: null, signal: null, teardown_started: false, exited_before_teardown: false };
  const line = mcpLauncherDiagnostic({ ...expected, pid: 123, log: "private-token", filename: "private-file" });
  assert.deepEqual(mcpWorkerFailureEvidence(line), [expected]);
  assert.deepEqual(mcpWorkerFailureEvidence(mcpLauncherDiagnostic({ ...expected, exit_code: 137, signal: "SIGKILL", exited_before_teardown: true })),
    [{ ...expected, exit_code: 137, signal: "SIGKILL", exited_before_teardown: true }]);
  for (const patch of [{ reason: "private" }, { exit_code: "137" }, { exit_code: 0.5 }, { exit_code: 2147483648 },
    { signal: "private" }, { teardown_started: "false" }, { exited_before_teardown: 1 }]) {
    assert.equal(mcpLauncherDiagnostic({ ...expected, ...patch }), undefined);
    assert.deepEqual(mcpWorkerFailureEvidence("RUNMESH_E2E_MCP_WORKER_EVENT=" + JSON.stringify({ ...expected, ...patch }) + "\n"), []);
  }
  assert.doesNotMatch(line, /private|123/u);
});

test("fixture diagnostics distinguish the primary error from cancellation and observation failures", async () => {
  const response = new Response("Error: Network connection lost.\n at private-cookie", { status: 500, headers: { "content-type": "text/plain" } });
  const httpError = await mcpHttpFailure(response, "private-id", "job", { action: "cancel", job_id: "private-job" });
  const primary = mcpFixtureFailureDiagnostic("queue", "primary", { name: "AssertionError", message: "private-assertion" });
  const cancel = mcpFixtureFailureDiagnostic("queue", "cancel", httpError);
  const observe = mcpFixtureFailureDiagnostic("queue", "observe", new Error("wait timed out: private details"));
  const events = mcpWorkerFailureEvidence(primary + cancel + observe);
  assert.deepEqual(events, [
    { event: "fixture_failure", fixture: "queue", phase: "primary", kind: "assertion_failed" },
    { event: "fixture_failure", fixture: "queue", phase: "cancel", kind: "mcp_http_failure", http_status: 500,
      mcp_response: { content_type: "text", phase: "job_cancel", body_kind: "non_json", rpc_code: "absent", rpc_id: "absent", runtime_signature: "network_connection_lost" } },
    { event: "fixture_failure", fixture: "queue", phase: "observe", kind: "timeout" },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private|Network connection lost/u);
  assert.equal(mcpFixtureFailureDiagnostic("private", "primary", httpError), undefined);
  assert.equal(mcpFixtureFailureDiagnostic("queue", "private", httpError), undefined);
  const marker = value => "RUNMESH_E2E_MCP_WORKER_EVENT=" + JSON.stringify(value) + "\n";
  for (const patch of [{ http_status: 600 }, { http_status: "500" }, { mcp_response: { content_type: "private" } }, { kind: "private" }])
    assert.deepEqual(mcpWorkerFailureEvidence(marker({ ...events[1], ...patch })), []);
  assert.deepEqual(mcpWorkerFailureEvidence("private " + cancel), []);
  assert.deepEqual(mcpWorkerFailureEvidence(cancel.trimEnd() + "private\n"), []);
});

test("runtime floods preserve the first fixture primary and independent launcher evidence", () => {
  const emitted = [], forward = createMcpWorkerDiagnosticForwarder(line => emitted.push(line));
  for (let i = 0; i < 40; i++) forward("Error: Network connection lost.\nRUNMESH_MCP_HANDLER_ERROR kind=error stage=sdk_transport reason=unknown\n");
  assert.equal(emitted.length, 24);
  const primary = mcpFixtureFailureDiagnostic("queue", "primary", { name: "AssertionError", message: "private" });
  const later = mcpFixtureFailureDiagnostic("queue", "primary", new Error("timed out"));
  const cleanup = mcpFixtureFailureDiagnostic("queue", "cancel", new Error("private"));
  const launcher = mcpLauncherDiagnostic({ reason: "test_failed", exit_code: null, signal: null, teardown_started: false, exited_before_teardown: false });
  const events = mcpWorkerFailureEvidence(emitted.join("").repeat(3) + primary + later.repeat(30) + cleanup.repeat(30) + launcher);
  assert.equal(events.filter(event => event.event === "runtime_log").length, 8);
  assert.equal(events.filter(event => event.event === "mcp_handler_error").length, 16);
  assert.deepEqual(events.filter(event => event.event === "fixture_failure" && event.phase === "primary"),
    [{ event: "fixture_failure", fixture: "queue", phase: "primary", kind: "assertion_failed" }]);
  assert.equal(events.filter(event => event.event === "fixture_failure" && event.phase === "cancel").length, 8);
  assert.equal(events.filter(event => event.event === "launcher_snapshot").length, 1);
  assert.ok(events.length <= 46);
});

test("a failed child preserves runtime, primary, cleanup and launcher classes through the existing CI outlet", () => {
  const helper = new URL("../scripts/mcp-diagnostics.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createMcpWorkerDiagnosticForwarder, mcpFixtureFailureDiagnostic, mcpLauncherDiagnostic } from ${JSON.stringify(helper)};
    const forward = createMcpWorkerDiagnosticForwarder(line => process.stderr.write(line));
    forward("[ERROR] Error: Network connection lost.\\nprivate worker stack\\n");
    process.stderr.write(mcpFixtureFailureDiagnostic("busy", "primary", {name:"AssertionError", message:"private-token"}));
    process.stderr.write(mcpFixtureFailureDiagnostic("busy", "cancel", new Error("private cleanup")));
    process.stderr.write(mcpLauncherDiagnostic({reason:"test_failed",exit_code:null,signal:null,teardown_started:false,exited_before_teardown:false}));
    process.stderr.write("private child stderr\\n"); process.exitCode = 1;
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 1);
  const summary = { error: browserErrorDiagnostic({ code: child.status }), worker_events: mcpWorkerFailureEvidence(child.stderr) };
  assert.deepEqual(summary.worker_events.map(event => event.event), ["runtime_log", "fixture_failure", "fixture_failure", "launcher_snapshot"]);
  assert.doesNotMatch(JSON.stringify(summary), /private/u);
});

test("direct browser failures use optional error stacks and retain only allowlisted source coordinates", () => {
  const error = { code: "ERR_ASSERTION", message: "private-response", stack: "AssertionError: private-token\n    at check (C:\\private\\scripts\\product-browser-check.mjs:108:10)" };
  assert.deepEqual(browserErrorDiagnostic(error), { kind: "assertion_failed", location: { file: "scripts/product-browser-check.mjs", line: 108, column: 10 } });
  assert.deepEqual(browserErrorDiagnostic({ message: "private-cookie", stack: "at /private/scripts/private-token.mjs:123:456" }), { kind: "unclassified" });
  assert.deepEqual(browserErrorDiagnostic({ code: 1, stdout: "private-token", stderr: "private-cookie" }), { kind: "process_exit" });
  assert.deepEqual(browserErrorDiagnostic(undefined), { kind: "unclassified" });
});

test("browser diagnostics bound retained failures and message inspection", () => {
  const summary = browserFailureEvidence({ testResults: [{ assertionResults: Array.from({ length: 40 }, () => ({
    status: "failed", title: "private-title", failureMessages: ["private-response"],
  })) }] });
  assert.equal(summary.failed_tests, 40); assert.equal(summary.failures.length, 16); assert.equal(summary.truncated, true);
  assert.ok(JSON.stringify(summary).length < 4096); assert.ok(!JSON.stringify(summary).includes("private"));
  const messages = Array.from({ length: 8 }, () => " ".repeat(16384));
  messages.push("AssertionError at /private/scripts/ui-browser-check.mjs:1:1");
  const bounded = browserFailureEvidence({ testResults: [{ assertionResults: [{ status: "failed", failureMessages: messages }] }] });
  assert.deepEqual(bounded.failures, [{ test_index: 1, required_browser_check: false, kind: "unclassified" }]);
});

test("AR08 architecture references cannot name missing source paths", async () => {
  assert.equal(await verifyDocReferences(root, "See `apps/runner/src/jobs/` and `packages/protocol/src/`."), 2);
  await assert.rejects(verifyDocReferences(root, "See `apps/worker/src/not-a-real-boundary.ts`."));
  await assert.rejects(verifyDocReferences(root, "See `apps/../private`."));
});

test("AR08 a listed Node test omitted from execution cannot silently pass the gate", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const github = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
  const gitlab = await readFile(join(root, ".gitlab-ci.yml"), "utf8");
  validateTestWiring(plan, pkg, github, gitlab);
  const changed = structuredClone(pkg);
  changed.scripts["test:release-tools"] = "node --test test/missing.test.mjs";
  assert.throws(() => validateTestWiring(plan, changed, github, gitlab));
  assert.throws(() => validateTestWiring(plan, pkg, github.replaceAll("- run: node scripts/ci-check.mjs installed_transport", "# removed installed transport"), gitlab));
});

test("AR08 every existing test has exactly one declared layer", async () => {
  assert.deepEqual(validateTestPlan(plan, await inventoryTests(root)), { groups: 8, files: files.length });
});
test("AR08 missing, duplicate, unknown and misclassified tests fail the inventory gate", () => {
  for (const mutate of [p => p.groups.pop(), p => p.groups[0].files.pop(), p => p.groups[1].files.push(p.groups[0].files[0]),
    p => p.groups[0].files.push("../../private.test.ts"), p => p.groups[0].id = "imaginary", p => p.external_checks = []]) {
    const value = structuredClone(plan); mutate(value); assert.throws(() => validateTestPlan(value, files));
  }
  assert.throws(() => validateTestPlan(plan, [...files, "test/not-classified.test.mjs"]));
});
test("AR08 domain lane rejects side effects through transitive imports", async t => {
  const dir = await mkdtemp(join(tmpdir(), "runmesh-domain-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "test/domain"), { recursive: true }); await mkdir(join(dir, "apps/runner/src"), { recursive: true });
  const path = join(dir, "test/domain/public.test.ts");
  await writeFile(path, 'import "../../apps/runner/src/effect.js";');
  await writeFile(join(dir, "apps/runner/src/effect.ts"), 'import "node:fs/promises";');
  await assert.rejects(checkDomainImports(dir, ["test/domain/public.test.ts"]), /side effect/);
  await writeFile(path, 'const value = manager as unknown as { secret: string };');
  await assert.rejects(checkDomainImports(dir, ["test/domain/public.test.ts"]), /private casts/);
});
function reporter() {
  return { success: true, numFailedTestSuites: 0, numTotalTests: 3, numPassedTests: 1, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1,
    testResults: [{ status: "passed", name: "/private/fixture", assertionResults: [
      { status: "passed", fullName: "private fixture", failureMessages: ["do not copy"] }, { status: "pending" }, { status: "todo" },
    ] }] };
}
test("AR08 reporter preserves skipped and todo counts without leaking raw fixture text", () => {
  const summary = summarizeVitest(reporter(), 0);
  assert.deepEqual(summary, { state: "passed", total: 3, passed: 1, failed: 0, skipped: 1, todo: 1, files: 1 });
  assert.ok(!JSON.stringify(summary).includes("private"));
});
test("AR08 reporter counts every completed status and still rejects actual failures", () => {
  const value = reporter(); value.numTotalTests++; value.numPendingTests++;
  value.testResults[0].assertionResults.push({ status: "skipped" });
  assert.deepEqual(summarizeVitest(value, 0), { state: "passed", total: 4, passed: 1, failed: 0, skipped: 2, todo: 1, files: 1 });
  value.numTotalTests++; value.numFailedTests++;
  value.testResults[0].assertionResults.push({ status: "failed" });
  assert.throws(() => summarizeVitest(value, 0), /an actual failure/u);
});
for (const status of ["constructor", "__proto__", "toString", "hasOwnProperty", ["passed"], null, 0, {}])
test("AR08 reporter rejects malformed status " + JSON.stringify(status), () => {
  const value = reporter(); value.numTotalTests++;
  if (Array.isArray(status)) value.numPassedTests++;
  value.testResults[0].assertionResults.push({ status });
  assert.throws(() => summarizeVitest(value, 0), /unknown\/incomplete test result/u);
});
test("AR08 exit zero, stale counts and success-looking reporters cannot fabricate verification", () => {
  assert.throws(() => summarizeVitest(reporter(), 1));
  for (const mutate of [r => r.success = false, r => r.numFailedTestSuites = 1, r => r.numTotalTests++,
    r => r.testResults = [], r => r.testResults[0].status = "failed", r => r.testResults[0].assertionResults[0].status = "running",
    r => r.testResults[0].assertionResults[0].status = "failed", r => r.testResults[0].assertionResults[0].status = "pending"]) {
    const value = reporter(); mutate(value); assert.throws(() => summarizeVitest(value, 0));
  }
});
test("AR08 package observations never imply signing, production or other native platforms", () => {
  const value = packageEvidence({ tests: summarizeVitest(reporter(), 0), source: { commit: "a".repeat(40), tree: "b".repeat(40), state: "dirty", email: "do-not-export" },
    artifact: { sha256: "c".repeat(64), bytes: 100, path: "/private" }, platform: "linux", arch: "arm64", node: "v22.23.2", elapsedMs: 1000 });
  assert.equal(value.source.state, "dirty"); assert.equal(value.artifact.signed, false); assert.equal(value.artifact.published, false);
  for (const key of ["production", "signed_release", "account_quotas", "host_catalog"]) assert.deepEqual(value[key], { state: "not_run" });
  assert.ok(!JSON.stringify(value).includes("private")); assert.ok(!JSON.stringify(value).includes("email"));
});
test("AR08 documentation must cover each real tool and action without fictional inputs", () => {
  const contract = { contractFacts: { tools: ["read"], actions: [{ tool: "read", action: "read" }] }, exampleProblem: e => e.arguments.bad ? "bad input" : undefined };
  const examples = [{ id: "file", tool: "read", action: "read", accepts: true, arguments: {} }];
  validateExampleCoverage(examples, contract);
  assert.throws(() => validateExampleCoverage([], contract));
  assert.throws(() => validateExampleCoverage([...examples, ...examples], contract));
  assert.throws(() => validateExampleCoverage([{ ...examples[0], arguments: { bad: true } }], contract));
  assert.throws(() => validateExampleCoverage(examples, { ...contract, contractFacts: { tools: ["unknown"], actions: [] } }));
});
test("AR08 generated text changes when source facts or examples change", () => {
  assert.notEqual(renderFacts({ tools: ["read"] }), renderFacts({ tools: ["read", "context"] }));
  const example = { id: "read", tool: "read", accepts: true, arguments: { limit: 12 } };
  assert.notEqual(renderExamples([example]), renderExamples([{ ...example, arguments: { limit: 13 } }]));
});
test("AR08 layered and actual-package commands are required in both CI systems", async () => {
  for (const command of ["npm run check:verification", "npm run test:package:e2e"]) assert.ok(Object.values(CI_CHECKS).includes(command));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const command of ["test:domain", "test:contracts"]) assert.ok(pkg.scripts["test:unit"].includes(`npm run ${command}`));
});
