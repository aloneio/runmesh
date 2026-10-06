import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { authenticateBrowserFixture, seedBrowserFixtureHistory } from "../scripts/browser-worker-fixture.mjs";
import { runFixtureCommand, spawnWorkerFixture, stopFixtureProcess, waitForWorker } from "../scripts/worker-fixture.mjs";

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

test("Fixture command timeout stops a descendant holding a local server", async () => {
  const descendant = "const s=require('node:http').createServer((q,r)=>r.end('alive'));s.listen(0,'127.0.0.1',()=>process.send(s.address().port))";
  const parent = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',p=>console.log(p))`;
  let port;
  await assert.rejects(runFixtureCommand(process.execPath, ["-e", parent], { timeout: 3_000, maxBuffer: 4_096 }), error => {
    assert.equal(error.killed, true);
    assert.equal(error.termination_reason, "timeout");
    port = Number(error.stdout.trim());
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535);
    return true;
  });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }));
});

test("Fixture command preserves a failed child's bounded private report for safe projection", async () => {
  await assert.rejects(runFixtureCommand(process.execPath, ["-e", "console.error('fixture-report-marker');process.exit(7)"], { timeout: 5_000, maxBuffer: 4_096 }), error => {
    assert.equal(error.code, 7);
    assert.equal(error.termination_reason, undefined);
    assert.match(error.stderr, /fixture-report-marker/u);
    return true;
  });
});

test("Fixture command bounds private output and classifies the initiating output limit", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await assert.rejects(runFixtureCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000)"], { timeout: 5_000, maxBuffer: 1_024 }), error => {
    assert.equal(error.termination_reason, "output_limit");
    assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    assert.equal(error.stdout, "x".repeat(1_024));
    assert.equal(error.killed, true);
    return true;
  });
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});

test("Fixture command preserves successful UTF-8 output split across stream chunks", async () => {
  const result = await runFixtureCommand(process.execPath, ["-e", "const b=Buffer.from('é😀');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),50)"], { timeout: 5_000, maxBuffer: 1_024 });
  assert.deepEqual(result, { stdout: "é😀", stderr: "" });
});
