import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { decodeWireFrame, encodeWireFrame, PROTOCOL_CURRENT_VERSION as version, PROTOCOL_MIN_VERSION } from "@aloneio/runmesh-protocol";
import { spawnWorkerFixture, stopFixtureProcess, waitForWorker } from "./worker-fixture.mjs";
import { createMcpWorkerDiagnosticForwarder } from "./mcp-diagnostics.mjs";

const prefix = "runmesh-browser-worker-";
const password = "browser-fixture-administrator-password";
const vars = {
  ADMIN_TOKEN: "browser-fixture-admin-token-0123456789abcdef",
  RUNNER_TOKEN_PEPPER: "browser-fixture-runner-token-pepper-not-for-production",
  INTERNAL_CONTROL_SECRET: "browser-fixture-internal-control-secret-not-for-production",
  RUNMESH_TEST_MODE: "1",
  RUNMESH_JOB_HISTORY_BACKEND: "sqlite",
};

function cookie(response, name) {
  const value = new RegExp(`${name}=([^;]+)`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(value, "Browser fixture authentication cookie is absent");
  return `${name}=${value}`;
}
function token(html) {
  const value = /name="csrf_token" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
  assert.ok(value, "Browser fixture authentication form is absent");
  return value;
}

/** Real setup/login and client creation, independent of Runner transport tests. */
export async function authenticateBrowserFixture(origin, fetchImpl = fetch) {
  assert.equal(new URL(origin).hostname, "127.0.0.1");
  const request = (path, init = {}) => fetchImpl(origin + path, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const form = (path, fields, cookies) => request(path, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: cookies }, body: new URLSearchParams(fields) });
  const setupPage = await request("/");
  assert.equal(setupPage.status, 200, "Browser fixture setup page failed");
  const setup = await form("/setup", { csrf_token: token(await setupPage.text()), password, confirm_password: password }, cookie(setupPage, "__Host-runmesh_setup_csrf"));
  await setup.body?.cancel();
  assert.equal(setup.status, 303, "Browser fixture administrator setup failed");
  const loginPage = await request("/");
  assert.equal(loginPage.status, 200, "Browser fixture login page failed");
  const login = await form("/login", { csrf_token: token(await loginPage.text()), password }, cookie(loginPage, "__Host-runmesh_login_csrf"));
  await login.body?.cancel();
  assert.equal(login.status, 303, "Browser fixture administrator login failed");
  const session = cookie(login, "__Host-runmesh_admin_session"), csrf = cookie(login, "__Host-runmesh_admin_csrf");
  const cookies = `${session}; ${csrf}`;
  const csrfToken = csrf.slice(csrf.indexOf("=") + 1);
  for (const label of ["Browser client A", "Browser client B"]) {
    const client = await form("/admin/clients", { csrf_token: csrfToken, label, scopes: "coding:read" }, cookies);
    await client.body?.cancel();
    assert.equal(client.status, 200, "Browser fixture client creation failed");
  }
  return cookies;
}

/** Seed persisted UI rows through the public registration and Runner APIs.
 * The socket closes before readback: the page must use saved history. */
export async function seedBrowserFixtureHistory(origin, cookies, fetchImpl = fetch) {
  assert.equal(new URL(origin).hostname, "127.0.0.1");
  const runnerId = "browser-fixture-runner", jobId = "browser-fixture-job", workspaceId = "browser-fixture-workspace";
  const runnerToken = "browser-fixture-runner-token-0123456789abcdef";
  const request = (path, init = {}) => fetchImpl(origin + path, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const registration = await request("/admin/runners", { method: "POST",
    headers: { authorization: `Bearer ${vars.ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ runner_id: runnerId, token: runnerToken, execution_mode: "dedicated_user" }) });
  await registration.body?.cancel();
  assert.equal(registration.status, 200, "Browser fixture Runner registration failed");
  const address = new URL("/runner/connect", origin); address.protocol = "ws:"; address.searchParams.set("runner_id", runnerId);
  const socket = new WebSocket(address, { headers: { authorization: `Bearer ${runnerToken}` }, handshakeTimeout: 10_000 });
  try {
    await new Promise((resolve, reject) => {
      let settled = false, welcomed = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer); error ? reject(error) : resolve();
      };
      const fail = () => finish(new Error("Browser fixture Runner history synchronization failed"));
      const send = message => socket.send(encodeWireFrame(message), error => { if (error) fail(); });
      const timer = setTimeout(fail, 10_000);
      socket.on("error", fail); socket.on("close", () => { if (!settled) fail(); });
      socket.on("unexpected-response", (_request, response) => { response.resume(); fail(); });
      socket.on("open", () => send({ type: "runner.hello", protocol_version: version, request_id: "browser-hello",
        min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: version,
        runner: { runner_id: runnerId, runner_version: "browser-fixture", platform: "test", architecture: "test", capabilities: {
          filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false,
          max_concurrent_jobs: 1, supported_rpc_methods: [], labels: {},
        } } }));
      socket.on("message", bytes => {
        if (settled) return;
        try {
          assert.ok(bytes.length <= 65_536);
          const frame = decodeWireFrame(bytes.toString());
          if (frame.type === "runner.welcome") {
            assert.ok(!welcomed && frame.request_id === "browser-hello" && frame.negotiated_protocol_version === version);
            welcomed = true;
            const now = Date.now();
            send({ type: "runner.sync", protocol_version: version, runner_id: runnerId, sync_sequence: 1, sent_at_ms: now,
              workspaces: [{ workspace_id: workspaceId, persistence: "persistent", labels: {} }],
              jobs: [{ job_id: jobId, workspace_id: workspaceId, status: "succeeded", created_at_ms: now, updated_at_ms: now }],
              extensions: { runmesh_history_ack: true } });
          } else if (frame.request_id === "history-1") {
            assert.ok(welcomed && frame.type === "rpc.response" && frame.result?.history_status === "recorded");
            finish();
          } else if (frame.type === "rpc.error") fail();
        } catch { fail(); }
      });
    });
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { socket.terminate(); finish(); }, 1_000);
      socket.once("close", finish);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "fixture seeded"); else socket.terminate();
    });
  }
  const dashboard = await request("/admin?lang=en", { headers: { cookie: cookies } });
  assert.equal(dashboard.status, 200, "Browser fixture dashboard readback failed");
  const html = await dashboard.text();
  assert.ok(html.includes(`href="/admin/runners/${runnerId}/jobs/${jobId}"`), "Browser fixture persisted Job is absent from the dashboard");
  assert.ok(html.includes(`href="/admin/runners/${runnerId}"`), "Browser fixture Runner is absent from the dashboard");
}

export async function createBrowserWorkerFixture() {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await realpath(await mkdtemp(join(temporaryRoot, prefix)));
  let child, closing;
  const close = () => closing ??= (async () => {
    await stopFixtureProcess(child);
    // Remove only this newly created, canonical, direct child of the temp root.
    assert.equal(dirname(directory), temporaryRoot);
    assert.ok(basename(directory).startsWith(prefix) && directory !== temporaryRoot);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  })();
  try {
    child = spawnWorkerFixture({ cwd: fileURLToPath(new URL("../", import.meta.url)), persistTo: directory, vars });
    const forward = createMcpWorkerDiagnosticForwarder(line => process.stderr.write(line));
    child.stdout.on("data", forward); child.stderr.on("data", forward);
    const origin = await waitForWorker(child, 60_000);
    const cookies = await authenticateBrowserFixture(origin);
    await seedBrowserFixtureHistory(origin, cookies);
    return { origin, cookies, close, assertRunning() {
      assert.equal(child.exitCode, null, "Browser fixture Worker exited");
      assert.equal(child.signalCode, null, "Browser fixture Worker was terminated");
    } };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
