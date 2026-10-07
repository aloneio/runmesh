import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { authenticateBrowserFixture, seedBrowserFixtureHistory } from "../scripts/browser-worker-fixture.mjs";
import { runFixtureCommand, spawnWorkerFixture, stopFixtureProcess, waitForWorker } from "../scripts/worker-fixture.mjs";
import { createTestHttpScope } from "../scripts/test-http-scope.mjs";
import * as browserDiagnostics from "../scripts/browser-evidence.mjs";
import { initializeSourceCheckout } from "./helpers/source-checkout.mjs";

async function localHttpFixture(t, handle) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    handle(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

test("Test HTTP scope keeps fixture setup requests outside a test usable", { timeout: 8_000 }, async t => {
  const scope = createTestHttpScope();
  const http = await localHttpFixture(t, (_, response) => response.end("fixture-ready"));
  await scope.run(new AbortController().signal, async () => {
    assert.equal(await (await scope.fetch(http.origin + "/test")).text(), "fixture-ready");
  });
  assert.equal(await (await scope.fetch(http.origin + "/setup")).text(), "fixture-ready");
  assert.deepEqual(http.requests, ["/test", "/setup"]);
});

for (const source of ["init", "request"]) test(`Test HTTP scope retains the caller's ${source} cancellation`, { timeout: 8_000 }, async t => {
  const scope = createTestHttpScope(), received = Promise.withResolvers();
  const caller = new AbortController();
  const http = await localHttpFixture(t, (request, response) => {
    if (request.url === "/held") received.resolve();
    else response.end("still-live");
  });
  await scope.run(new AbortController().signal, async () => {
    const pending = source === "request"
      ? scope.fetch(new Request(http.origin + "/held", { signal: caller.signal }))
      : scope.fetch(http.origin + "/held", { signal: caller.signal });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await received.promise;
    caller.abort();
    await rejected;
    assert.equal(await (await scope.fetch(http.origin + "/after-caller-abort")).text(), "still-live");
  });
  assert.deepEqual(http.requests, ["/held", "/after-caller-abort"]);
});

test("Test HTTP scope cancels an unfinished response body when its test aborts", { timeout: 8_000 }, async t => {
  const scope = createTestHttpScope(), testLifetime = new AbortController();
  const http = await localHttpFixture(t, (_, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("partial-response");
  });
  await scope.run(testLifetime.signal, async () => {
    const response = await scope.fetch(http.origin + "/stream");
    assert.equal(response.status, 200);
    const rejected = assert.rejects(response.text(), { name: "AbortError" });
    testLifetime.abort();
    await rejected;
    await assert.rejects(async () => scope.fetch(http.origin + "/late"), { name: "AbortError" });
  });
  assert.deepEqual(http.requests, ["/stream"]);
});

for (const outcome of ["success", "failure"]) test(`Test HTTP scope stops inherited continuations after ${outcome}`, { timeout: 8_000 }, async t => {
  const scope = createTestHttpScope(), release = Promise.withResolvers();
  const failure = new Error("original-test-failure");
  const http = await localHttpFixture(t, (_, response) => response.end("ready"));
  let continuation;
  const completed = scope.run(new AbortController().signal, async () => {
    continuation = (async () => {
      await release.promise;
      return scope.fetch(http.origin + "/late-mutation", { method: "POST", body: "fixture-value" });
    })();
    assert.equal(await (await scope.fetch(http.origin + "/initial")).text(), "ready");
    if (outcome === "failure") throw failure;
    return "original-result";
  });
  if (outcome === "failure") await assert.rejects(completed, error => error === failure);
  else assert.equal(await completed, "original-result");
  const rejected = assert.rejects(continuation, { name: "AbortError" });
  // Run the old continuation while a new test is active. Async ownership must
  // remain with its closed scope, rather than borrow the newer test's signal.
  await scope.run(new AbortController().signal, async () => {
    release.resolve();
    await rejected;
    assert.equal(await (await scope.fetch(http.origin + "/next-test")).text(), "ready");
  });
  assert.deepEqual(http.requests, ["/initial", "/next-test"]);
});

test("Test HTTP scope aborting one parallel test leaves the other request alive", { timeout: 8_000 }, async t => {
  const scope = createTestHttpScope(), firstLifetime = new AbortController();
  const firstReceived = Promise.withResolvers(), secondReceived = Promise.withResolvers();
  const http = await localHttpFixture(t, (request, response) => {
    if (request.url === "/first") firstReceived.resolve();
    else secondReceived.resolve(response);
  });
  const first = scope.run(firstLifetime.signal, async () => (await scope.fetch(http.origin + "/first")).text());
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = scope.run(new AbortController().signal, async () => (await scope.fetch(http.origin + "/second")).text());
  await firstReceived.promise;
  const secondResponse = await secondReceived.promise;
  firstLifetime.abort();
  await rejected;
  secondResponse.end("second-completed");
  assert.equal(await second, "second-completed");
  assert.deepEqual([...http.requests].sort(), ["/first", "/second"]);
});

function authenticationResponses() {
  const csrf = "x".repeat(43), form = `<input name="csrf_token" value="${csrf}">`;
  return [new Response(form, { headers: { "set-cookie": "__Host-runmesh_setup_csrf=setup-cookie" } }),
    new Response(null, { status: 303 }),
    new Response(form, { headers: { "set-cookie": "__Host-runmesh_login_csrf=login-cookie" } }),
    new Response(null, { status: 303, headers: { "set-cookie": "__Host-runmesh_admin_session=session-cookie; Path=/, __Host-runmesh_admin_csrf=admin-csrf; Path=/" } }),
    new Response("private one-time client receipt"), new Response("private one-time client receipt")];
}

test("Browser fixture authenticates and creates two clients before seeding Runner history", async () => {
  const responses = authenticationResponses(), calls = [];
  const cookie = await authenticateBrowserFixture("http://127.0.0.1:1234", async (url, init) => {
    calls.push({ path: new URL(url).pathname, ...init });
    return responses.shift();
  });
  assert.equal(cookie, "__Host-runmesh_admin_session=session-cookie; __Host-runmesh_admin_csrf=admin-csrf");
  assert.deepEqual(calls.map(call => call.path), ["/", "/setup", "/", "/login", "/admin/clients", "/admin/clients"]);
  assert.equal(calls[1].headers.cookie, "__Host-runmesh_setup_csrf=setup-cookie");
  assert.equal(calls[3].headers.cookie, "__Host-runmesh_login_csrf=login-cookie");
  assert.deepEqual(calls.slice(4).map(call => call.body.get("label")), ["Browser client A", "Browser client B"]);
  for (const call of calls.slice(4)) {
    assert.equal(call.body.get("csrf_token"), "admin-csrf");
    assert.equal(call.headers.cookie, cookie);
    assert.equal(call.headers.origin, "http://127.0.0.1:1234");
  }
  assert.equal(responses.length, 0);
});

test("Browser fixture fails a rejected seed request without exposing its response", async () => {
  const responses = authenticationResponses();
  responses[4] = new Response("PRIVATE_RESPONSE_DETAIL", { status: 503 });
  await assert.rejects(authenticateBrowserFixture("http://127.0.0.1:1234", async () => responses.shift()), error => {
    assert.match(error.message, /Browser fixture client creation failed/u);
    assert.ok(!error.message.includes("PRIVATE_RESPONSE_DETAIL"));
    return true;
  });
  assert.equal(responses.length, 1, "A failed setup must not continue creating clients");
});

for (const outcome of ["recorded", "degraded", "missing_row"]) test(`Browser fixture public Runner history seed ${outcome}`, async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const frames = [], requests = [];
  server.on("connection", (socket, request) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    socket.on("message", bytes => {
      const frame = JSON.parse(bytes.toString()); frames.push(frame);
      if (frame.type === "runner.hello") socket.send(JSON.stringify({ type: "runner.welcome", protocol_version: frame.protocol_version,
        worker: { worker_id: "fixture-worker", worker_version: "browser-fixture", capabilities: frame.runner.capabilities },
        request_id: frame.request_id, session_id: "fixture-session", negotiated_protocol_version: frame.max_protocol_version }));
      else socket.send(JSON.stringify({ type: "rpc.response", protocol_version: frame.protocol_version, request_id: "history-1",
        result: { history_status: outcome === "degraded" ? "degraded" : "recorded", private: "PRIVATE_HISTORY_VALUE" } }));
    });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const seed = seedBrowserFixtureHistory(origin, "fixture-session-cookie", async (url, init) => {
    const path = new URL(url).pathname; requests.push({ path, init });
    if (path === "/admin/runners") return Response.json({ token: "PRIVATE_REGISTRATION_RECEIPT" });
    assert.equal(init.headers.cookie, "fixture-session-cookie");
    return new Response(outcome === "missing_row" ? "No recent jobs." : '<a href="/admin/runners/browser-fixture-runner">Runner</a><a href="/admin/runners/browser-fixture-runner/jobs/browser-fixture-job">Job</a>');
  });
  if (outcome === "recorded") await seed;
  else await assert.rejects(seed, error => {
    assert.match(error.message, outcome === "degraded" ? /history synchronization failed/u : /persisted Job is absent/u);
    assert.doesNotMatch(error.message, /PRIVATE/u); return true;
  });
  assert.deepEqual(frames.map(frame => frame.type), ["runner.hello", "runner.sync"]);
  assert.equal(frames[1].jobs.length, 1);
  assert.equal(frames[1].jobs[0].status, "succeeded");
  assert.equal(frames[1].jobs[0].workspace_id, frames[1].workspaces[0].workspace_id);
  assert.deepEqual(frames[1].extensions, { runmesh_history_ack: true });
  assert.deepEqual(requests.map(request => request.path), ["/admin/runners", "/runner/connect?runner_id=browser-fixture-runner", ...(outcome === "degraded" ? [] : ["/admin"])]);
  const registration = JSON.parse(requests[0].init.body);
  assert.equal(registration.execution_mode, "dedicated_user");
  assert.equal(requests[1].authorization, `Bearer ${registration.token}`);
});

test("Shared Worker launch owns an IPC-discovered port and shuts down its process", async t => {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await realpath(await mkdtemp(join(temporaryRoot, "browser-fixture-test-")));
  let child;
  t.after(async () => {
    await stopFixtureProcess(child);
    assert.equal(dirname(directory), temporaryRoot);
    assert.ok(basename(directory).startsWith("browser-fixture-test-") && directory !== temporaryRoot);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const bin = join(directory, "node_modules/wrangler/bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "wrangler.js"), `
    const { createServer } = require('node:http');
    const server = createServer((_, response) => response.end('healthy'));
    server.listen(0, '127.0.0.1', () => {
      process.send({ event: 'fixture_arguments', args: process.argv.slice(2), role: process.env.FIXTURE_ROLE });
      process.send(JSON.stringify({ event: 'DEV_SERVER_READY', ip: '127.0.0.1', port: server.address().port }));
    });
  `);
  child = spawnWorkerFixture({ cwd: directory, persistTo: directory, vars: { FIXTURE_ROLE: "browser" } });
  child.stdout.resume(); child.stderr.resume();
  const argumentsSeen = new Promise(resolve => child.on("message", value => { if (value?.event === "fixture_arguments") resolve(value); }));
  const origin = await waitForWorker(child, 10_000);
  const observed = await argumentsSeen;
  assert.equal(observed.role, "browser");
  assert.equal(observed.args[observed.args.indexOf("--port") + 1], "0");
  assert.equal(observed.args[observed.args.indexOf("--inspector-port") + 1], "0");
  assert.equal((await fetch(origin + "/health")).status, 200);
  await stopFixtureProcess(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(fetch(origin + "/health", { signal: AbortSignal.timeout(1_000) }));
});

test("Fixture command timeout terminates a command before readiness", async () => {
  await assert.rejects(runFixtureCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 3_000, maxBuffer: 4_096 }), error => {
    assert.equal(error.killed, true);
    assert.equal(error.termination_reason, "timeout");
    assert.equal(error.stdout, "");
    return true;
  });
});

test("Fixture command preserves a failed child's bounded private report for safe projection", async () => {
  await assert.rejects(runFixtureCommand(process.execPath, ["-e", "console.error('fixture-report-marker');process.exit(7)"], { timeout: 5_000, maxBuffer: 4_096 }), error => {
    assert.equal(error.code, 7);
    assert.equal(error.termination_reason, undefined);
    assert.match(error.stderr, /fixture-report-marker/u);
    return true;
  });
});

test("Fixture command bounds private output and stops a descendant holding a local server", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const descendant = "const s=require('node:http').createServer((q,r)=>r.end('alive'));s.listen(0,'127.0.0.1',()=>process.send(s.address().port))";
  // Trigger cleanup only after the descendant owns its port; startup is not the timeout assertion.
  const parent = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',p=>process.stdout.write(String(p)+'\\n'+'x'.repeat(65536)))`;
  let port;
  await assert.rejects(runFixtureCommand(process.execPath, ["-e", parent], { timeout: 10_000, maxBuffer: 1_024 }), error => {
    assert.equal(error.termination_reason, "output_limit");
    assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    const [portText, output] = error.stdout.split("\n");
    port = Number(portText);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535);
    assert.equal(error.stdout.length, 1_024);
    assert.equal(output, "x".repeat(1_024 - portText.length - 1));
    assert.equal(error.killed, true);
    return true;
  });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }));
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});

test("Fixture command preserves successful UTF-8 output split across stream chunks", async () => {
  const result = await runFixtureCommand(process.execPath, ["-e", "const b=Buffer.from('é😀');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),50)"], { timeout: 5_000, maxBuffer: 1_024 });
  assert.deepEqual(result, { stdout: "é😀", stderr: "" });
});

test("Browser cleanup retains the primary failure and starts independent cleanup before a slow browser closes", async () => {
  const closed = Promise.withResolvers(), entered = Promise.withResolvers(), emitted = [], calls = [];
  const primary = Object.assign(new Error("PRIVATE_PRIMARY"), { code: "ERR_ASSERTION" });
  const pending = browserDiagnostics.withBrowserFixtureCleanup(async () => { throw primary; }, [
    { phase: "browser_close", run: async () => { calls.push("browser"); entered.resolve(); await closed.promise; throw new Error("PRIVATE_CLOSE"); } },
    { phase: "fixture_close", run: async () => { calls.push("fixture"); } },
    { phase: "temporary_cleanup", run: async () => { calls.push("temporary"); } },
  ], text => emitted.push(text));
  const rejected = assert.rejects(pending, error => error === primary);
  await entered.promise; await new Promise(setImmediate);
  assert.deepEqual(calls, ["browser", "fixture", "temporary"]);
  assert.deepEqual(browserDiagnostics.browserFixtureFailureEvidence(emitted.join("")), [{ phase: "primary", error: { kind: "assertion_failed" } }]);
  closed.resolve(); await rejected;
  assert.deepEqual(browserDiagnostics.browserFixtureFailureEvidence(emitted.join("")), [
    { phase: "primary", error: { kind: "assertion_failed" } }, { phase: "browser_close", error: { kind: "unclassified" } },
  ]);
  assert.doesNotMatch(emitted.join(""), /PRIVATE_/u);
});

test("Browser cleanup failure fails an otherwise successful check and reports each failed resource", async () => {
  const emitted = [], calls = [];
  await assert.rejects(browserDiagnostics.withBrowserFixtureCleanup(async () => "passed", [
    { phase: "browser_close", run: () => { calls.push("browser"); throw Object.assign(new Error("PRIVATE_CLOSE"), { code: "EACCES" }); } },
    { phase: "fixture_close", run: async () => { calls.push("fixture"); throw new Error("PRIVATE_SERVER timed out"); } },
    { phase: "temporary_cleanup", run: async () => { calls.push("temporary"); } },
  ], text => emitted.push(text)), error => error instanceof AggregateError && error.errors.length === 2);
  assert.deepEqual(calls, ["browser", "fixture", "temporary"]);
  assert.deepEqual(browserDiagnostics.browserFixtureFailureEvidence(emitted.join("")), [
    { phase: "browser_close", error: { kind: "permission_denied" } }, { phase: "fixture_close", error: { kind: "timeout" } },
  ]);
  assert.doesNotMatch(emitted.join(""), /PRIVATE_/u);
});

test("Guided browser diagnostics project only fixed stages and classified failure fields", () => {
  const lines = ["PRIVATE_BODY", browserDiagnostics.guidedProductStageMarker("layout_navigation"),
    "RUNMESH_GUIDED_PRODUCT_STAGE=PRIVATE_STAGE\n", browserDiagnostics.guidedProductStageMarker("layout_measure"),
    "RUNMESH_GUIDED_PRODUCT_STAGE=layout_cleanup PRIVATE_SUFFIX\n"];
  assert.equal(browserDiagnostics.guidedProductStageEvidence(lines.join("\n")), "layout_measure");
  assert.throws(() => browserDiagnostics.guidedProductStageMarker("PRIVATE_STAGE"));
  const marker = value => "RUNMESH_BROWSER_FIXTURE_FAILURE=" + JSON.stringify(value) + "\n";
  const output = browserDiagnostics.browserFixtureFailureEvidence([
    marker({ phase: "primary", error: { kind: "assertion_failed", message: "PRIVATE_MESSAGE", location: { file: "scripts/layout-browser-check.mjs", line: 20, column: 3 }, PRIVATE_FIELD: true } }),
    marker({ phase: "browser_close", error: { kind: "PRIVATE_KIND" } }),
    marker({ phase: "PRIVATE_PHASE", error: { kind: "timeout" } }),
    marker({ phase: "temporary_cleanup", error: { kind: "permission_denied", location: { file: "/PRIVATE/path", line: 1, column: 1 } } }),
  ].join(""));
  assert.deepEqual(output, [{ phase: "primary", error: { kind: "assertion_failed", location: { file: "scripts/layout-browser-check.mjs", line: 20, column: 3 } } },
    { phase: "temporary_cleanup", error: { kind: "permission_denied" } }]);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_/u);
});

async function browserGateFixture(t) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "runmesh-browser-wrapper-"));
  t.after(async () => {
    const abandoned = await readFile(join(directory, "evidence-directory"), "utf8").catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (abandoned !== undefined) {
      assert.equal(dirname(abandoned), await realpath(tmpdir())); assert.ok(basename(abandoned).startsWith("runmesh-browser-gate-"));
      await rm(abandoned, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
    assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith("runmesh-browser-wrapper-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "node_modules/vitest"), { recursive: true });
  for (const file of ["run-browser-e2e.mjs", "worker-fixture.mjs", "windows-tools.mjs", "ci-report.mjs", "source-git.mjs", "ci-supplement.mjs", "browser-evidence.mjs", "test-evidence.mjs", "evidence-io.mjs", "mcp-diagnostics.mjs", "ui-browser-contract.mjs", "ui-browser-diagnostics.mjs"])
    await writeFile(join(directory, "scripts", file === "worker-fixture.mjs" ? "actual-worker-fixture.mjs" : file), await readFile(join(root, "scripts", file)));
  await writeFile(join(directory, "scripts/build-provenance.mjs"), "export async function writeBuildProvenance() {}\n");
  // Keep real process-tree management and ordinary startup budgets. Shorten
  // only the deliberately hung guided child; the outer watchdog bounds tests.
  await writeFile(join(directory, "scripts/worker-fixture.mjs"), `
    import { appendFileSync } from 'node:fs';
    import { runFixtureCommand as actual } from './actual-worker-fixture.mjs';
    export function runFixtureCommand(file, args, options) {
      appendFileSync('budgets.jsonl', JSON.stringify({ timeout: options.timeout }) + '\\n');
      const injectedHang = args[0].endsWith('/scripts/product-browser-check.mjs') && ['hang', 'cleanup_hang'].includes(process.env.BROWSER_FIXTURE_MODE);
      return actual(file, args, { ...options, timeout: injectedHang ? Math.min(options.timeout, 1500) : options.timeout });
    }
  `);
  await writeFile(join(directory, "node_modules/vitest/vitest.mjs"), `
    import { writeFileSync } from 'node:fs';
    await new Promise(resolve => setTimeout(resolve, 350));
    const report = JSON.stringify({ success: true, numFailedTestSuites: 0,
      numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
      testResults: [{ status: 'passed', name: '/private/test/browser/admin-ui.browser.test.ts', assertionResults: [{
        status: 'passed', title: 'renders stable single-locale dashboard and navigation in Chromium' }] }] });
    const offset = report.indexOf('private');
    writeFileSync(process.env.RUNMESH_TEST_RESULT_PATH, process.env.BROWSER_FIXTURE_MODE === 'invalid_utf8_report'
      ? Buffer.concat([Buffer.from(report.slice(0, offset)), Buffer.from([255]), Buffer.from(report.slice(offset + 1))])
      : report);
  `);
  // Inject an actual path change after the public stat boundary. The gate must
  // reject the changed evidence without waiting for a FIFO writer or decoding
  // a substituted file as the original report.
  await writeFile(join(directory, "evidence-race-hook.mjs"), `
    import fs from 'node:fs';
    import { basename, dirname } from 'node:path';
    import { execFileSync } from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.promises.lstat;
    let changed = false;
    fs.promises.lstat = async (file, ...args) => {
      const info = await original(file, ...args);
      if (!changed && basename(String(file)) === 'result.json' && basename(dirname(String(file))).startsWith('runmesh-browser-gate-')) {
        changed = true;
        const mode = process.env.BROWSER_FIXTURE_MODE;
        if (mode === 'report_growth_race' || mode === 'failed_report_growth_race') fs.appendFileSync(file, Buffer.alloc(8 * 1024 * 1024, 32));
        if (mode === 'report_symlink_race') { fs.renameSync(file, String(file) + '.original'); fs.symlinkSync(String(file) + '.original', file); }
        if (mode === 'report_fifo_race') { fs.writeFileSync('evidence-directory', dirname(String(file))); fs.unlinkSync(file); execFileSync('mkfifo', [String(file)]); }
      }
      return info;
    };
    syncBuiltinESMExports();
  `);
  await writeFile(join(directory, "scripts/product-browser-check.mjs"), `
    import { writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    import { pathToFileURL } from 'node:url';
    import { resolve } from 'node:path';
    export async function checkGuidedProduct() {
      writeFileSync('guided-started', 'yes');
      console.log('PRIVATE_GUIDED_STDOUT'); console.error('PRIVATE_GUIDED_STDERR');
      console.log('RUNMESH_GUIDED_PRODUCT_STAGE=layout_measure');
      console.log('RUNMESH_GUIDED_PRODUCT_STAGE=PRIVATE_STAGE');
      const mode = process.env.BROWSER_FIXTURE_MODE;
      if (mode === 'source_change') writeFileSync('source.txt', 'changed source');
      if (mode === 'hang' || mode === 'cleanup_hang') {
        const child = spawn(process.execPath, ['-e', "const s=require('node:http').createServer((q,r)=>r.end('alive'));s.listen(0,'127.0.0.1',()=>process.send(s.address().port))"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const port = await new Promise(resolve => child.once('message', resolve));
        writeFileSync('descendant-port', String(port));
        try { if (mode === 'cleanup_hang') {
          console.error('RUNMESH_BROWSER_FIXTURE_FAILURE=' + JSON.stringify({ phase: 'primary', error: { kind: 'assertion_failed', message: 'PRIVATE_PRIMARY', location: { file: 'scripts/layout-browser-check.mjs', line: 20, column: 3 } } }));
          throw new Error('PRIVATE_ORIGINAL_FAILURE');
        } await new Promise(() => {}); }
        finally { await new Promise(() => {}); }
      }
      if (mode === 'failure' || mode === 'failed_report_growth_race') {
        console.error('RUNMESH_BROWSER_FIXTURE_FAILURE=' + JSON.stringify({ phase: 'primary', error: { kind: 'assertion_failed', location: { file: 'scripts/product-browser-check.mjs', line: 27, column: 3 } } }));
        console.error('RUNMESH_BROWSER_FIXTURE_FAILURE=' + JSON.stringify({ phase: 'browser_close', error: { kind: 'timeout' } }));
        const error = new Error('AssertionError: PRIVATE_ASSERTION');
        error.stack = 'Error: AssertionError: PRIVATE_ASSERTION\\n at fixture (scripts/product-browser-check.mjs:27:3)'; throw error;
      }
      if (mode === 'invalid_result') return { state: 'failed', screenshots: 0 };
      return { state: 'passed', screenshots: 0, PRIVATE_FIELD: 'PRIVATE_VALUE' };
    }
    if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
      if (process.env.BROWSER_FIXTURE_MODE !== 'missing_result') console.log(JSON.stringify(await checkGuidedProduct()));
    }
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:RUNMESH_|GIT_)/u.test(key)));
  return { directory, async invoke(mode) {
    await rm(join(directory, "budgets.jsonl"), { force: true });
    try {
      return { code: 0, ...await runFixtureCommand(process.execPath, ["--import", pathToFileURL(join(directory, "evidence-race-hook.mjs")).href, join(directory, "scripts/run-browser-e2e.mjs")], {
        cwd: directory, env: { ...env, BROWSER_FIXTURE_MODE: mode, RUNMESH_CHROMIUM_EXECUTABLE: process.execPath }, timeout: 7000, maxBuffer: 65536,
      }) };
    } catch (error) { return { code: error.code, error, stdout: error.stdout, stderr: error.stderr }; }
  }, async report(name = "browser-tests") { return JSON.parse(await readFile(join(directory, "ci-results", name + ".json"), "utf8")); } };
}

for (const mode of ["report_growth_race", "report_symlink_race", "report_fifo_race", "invalid_utf8_report", "failed_report_growth_race"])
  test(`Browser gate rejects ${mode} through the shared evidence boundary`, { skip: process.platform !== "linux" }, async t => {
    const f = await browserGateFixture(t);
    assert.equal((await f.invoke("success")).code, 0);
    const result = await f.invoke(mode), report = await f.report();
    assert.equal(result.error?.termination_reason, undefined, "evidence rejection must finish before the outer watchdog");
    assert.equal(result.code, 1);
    assert.equal((await f.report("browser")).state, "failed");
    assert.equal(report.state, "failed");
    assert.equal(report.stage, mode === "failed_report_growth_race" ? "guided_product" : "evidence_validation");
    assert.equal(report.report_available, false);
    assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(report), /PRIVATE_|"browser_gate":"passed"/u);
  });

for (const mode of ["hang", "cleanup_hang"]) test(`Browser gate bounds guided product ${mode} and its descendants`, { skip: process.platform !== "linux" }, async t => {
  const f = await browserGateFixture(t), result = await f.invoke(mode);
  assert.equal(result.error?.termination_reason, undefined, "the gate must return before the outer test watchdog");
  assert.equal(result.code, 1);
  assert.equal((await f.report("browser")).state, "timed_out");
  const report = await f.report(); assert.equal(report.state, "failed"); assert.equal(report.stage, "guided_product");
  assert.equal(report.termination_reason, "timeout");
  assert.equal(report.guided_product_stage, "layout_measure");
  if (mode === "cleanup_hang") assert.deepEqual(report.guided_product_failures,
    [{ phase: "primary", error: { kind: "assertion_failed", location: { file: "scripts/layout-browser-check.mjs", line: 20, column: 3 } } }]);
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(report), /PRIVATE_/u);
  const port = Number(await readFile(join(f.directory, "descendant-port"), "utf8"));
  await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }));
});

test("Browser gate rejects source changes after successful browser and guided checks", { skip: process.platform !== "linux" }, async t => {
  const f = await browserGateFixture(t);
  const { source } = await initializeSourceCheckout(f.directory, ["budgets.jsonl", "guided-started"]);
  assert.equal((await f.invoke("success")).code, 0);
  assert.deepEqual((await f.report()).source, source);
  const result = await f.invoke("source_change"), report = await f.report();
  assert.equal(result.code, 1); assert.equal((await f.report("browser")).state, "failed");
  assert.equal(report.state, "failed"); assert.equal(report.stage, "source_validation"); assert.deepEqual(report.source, source);
  assert.doesNotMatch(result.stdout, /"browser_gate":"passed"/u);
});

test("Browser gate shares its deadline and publishes only validated guided evidence", { skip: process.platform !== "linux" }, async t => {
  const f = await browserGateFixture(t), result = await f.invoke("success");
  assert.equal(result.code, 0, result.stderr);
  const budgets = (await readFile(join(f.directory, "budgets.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(budgets.length, 2); assert.ok(budgets[1].timeout < budgets[0].timeout - 300);
  assert.deepEqual(JSON.parse(result.stdout.trim()).guided_product, { state: "passed", screenshots: 0 });
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(await f.report()), /PRIVATE_/u);
  assert.equal((await f.report("browser")).state, "passed");
  for (const mode of ["failure", "missing_result", "invalid_result"]) {
    const failed = await f.invoke(mode), report = await f.report();
    assert.equal(failed.code, 1); assert.equal(report.state, "failed"); assert.equal(report.stage, "guided_product");
    if (mode === "invalid_result") assert.equal(report.guided_product_stage, "layout_measure");
    assert.equal((await f.report("browser")).state, "failed");
    assert.doesNotMatch(failed.stdout + failed.stderr + JSON.stringify(report), /PRIVATE_/u);
    if (mode === "failure") {
      assert.equal(report.subprocess_exit_code, 1);
      assert.deepEqual(report.guided_product_error, { kind: "assertion_failed", location: { file: "scripts/product-browser-check.mjs", line: 27, column: 3 } });
      assert.deepEqual(report.guided_product_failures, [
        { phase: "primary", error: { kind: "assertion_failed", location: { file: "scripts/product-browser-check.mjs", line: 27, column: 3 } } },
        { phase: "browser_close", error: { kind: "timeout" } },
      ]);
    }
  }
});
