import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTrustedTaskkillPath } from "./windows-tools.mjs";

// This child exposes Wrangler's native Miniflare entry socket, retaining its
// core/assets router and real bindings while excluding the dev reload proxy hop.
const configuration = process.env.RUNMESH_WORKER_FIXTURE_CONFIGURATION;
delete process.env.RUNMESH_WORKER_FIXTURE_CONFIGURATION;
let devEnv, stopping = false, reloadSeen = false, forceStopping = false, phase = "configuration";

function reportFailure(failedPhase) {
  try { writeSync(2, `Native Worker fixture launch failed phase=${failedPhase}\n`); } catch { /* Preserve failure. */ }
}

function fail(failedPhase = phase) {
  if (stopping) { process.exitCode = 1; return; }
  // Wrangler errors may contain fixture bindings or request URLs. The parent
  // records the failed child; only this fixed launcher message is public here.
  reportFailure(failedPhase);
  void shutdown(1);
}

function forceTreeCleanup() {
  if (forceStopping) return;
  forceStopping = true;
  process.exitCode = 1;
  reportFailure("teardown");
  // The launcher is itself the root of the detached fixture group. Retain it
  // until tree termination, so the parent's bounded cleanup can still own the
  // whole group if the operating system rejects this termination attempt.
  setInterval(() => {}, 1_000);
  try {
    if (process.platform === "win32") {
      const killer = spawn(resolveTrustedTaskkillPath(), ["/PID", String(process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => reportFailure("teardown"));
      killer.once("exit", code => { if (code !== 0) reportFailure("teardown"); });
    } else process.kill(-process.pid, "SIGKILL");
  } catch { reportFailure("teardown"); }
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  const deadline = setTimeout(forceTreeCleanup, 5_000);
  try { await devEnv?.teardown(); }
  catch { forceTreeCleanup(); }
  finally {
    clearTimeout(deadline);
    if (!forceStopping) process.exit(process.exitCode ?? code);
  }
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("disconnect", () => void shutdown(0));

function loopbackOrigin(value) {
  const url = new URL(value);
  assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1"
    && url.username === "" && url.password === "" && url.pathname === "/"
    && url.search === "" && url.hash === "" && /^[1-9][0-9]*$/u.test(url.port)
    && Number(url.port) <= 65_535, "Invalid native Worker address");
  return url;
}

async function announce(event) {
  if (stopping) return;
  // With watching disabled, a second reload changes the fixture under test.
  phase = reloadSeen ? "runtime_reload" : "runtime_ready";
  assert.equal(reloadSeen, false, "Native Worker fixture reloaded");
  reloadSeen = true;
  const runtimes = devEnv.runtimes.map(runtime => runtime.mf).filter(Boolean);
  assert.equal(runtimes.length, 1, "Expected one local Worker runtime");
  const nativeUrl = loopbackOrigin(await runtimes[0].ready);
  const parts = event?.proxyData?.userWorkerUrl;
  assert.ok(parts?.protocol === "http:" && parts.hostname === "127.0.0.1" && /^[1-9][0-9]*$/u.test(parts.port), "Invalid native Worker readiness event");
  const announcedUrl = loopbackOrigin(`${parts.protocol}//${parts.hostname}:${parts.port}/`);
  assert.equal(nativeUrl.href, announcedUrl.href, "Native Worker readiness addresses differ");
  if (stopping) return;
  assert.ok(process.connected && process.send, "Worker fixture parent disconnected");
  await new Promise((resolve, reject) => {
    process.send({ event: "DEV_SERVER_READY", ip: nativeUrl.hostname, port: Number(nativeUrl.port) }, error => error ? reject(error) : resolve());
  });
}

try {
  assert.ok(process.connected && process.send, "Native Worker fixture requires parent IPC");
  const input = JSON.parse(configuration);
  assert.ok(isAbsolute(input.persistTo) && input.vars !== null && typeof input.vars === "object" && !Array.isArray(input.vars), "Invalid Worker fixture configuration");
  assert.ok(Object.entries(input.vars).every(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && typeof value === "string"), "Invalid Worker fixture variables");
  const require = createRequire(join(process.cwd(), "node_modules/wrangler/package.json"));
  phase = "import";
  const { unstable_DevEnv, unstable_convertConfigBindingsToStartWorkerBindings } = await import(pathToFileURL(require.resolve("wrangler")).href);
  if (!stopping) {
    devEnv = new unstable_DevEnv();
    devEnv.on("error", () => fail());
    devEnv.on("buildFailed", () => fail("start"));
    devEnv.on("reloadComplete", event => { void announce(event).catch(() => fail()); });
    phase = "start";
    await devEnv.startWorker({
      config: join(process.cwd(), "apps/worker/wrangler.jsonc"),
      bindings: unstable_convertConfigBindingsToStartWorkerBindings({ vars: input.vars }),
      dev: {
        remote: false, server: { hostname: "127.0.0.1", port: 0, secure: false },
        inspector: false, watch: false, liveReload: false, persist: input.persistTo,
        logLevel: "warn", inferOriginFromRoutes: false,
      },
    });
  }
} catch { fail(); }
