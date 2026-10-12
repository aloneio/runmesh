import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import assert from "node:assert/strict";
import { resolveTrustedTaskkillPath } from "./windows-tools.mjs";

/** Source and browser fixtures share the exact local Worker launch contract. */
export function spawnWorkerFixture({ cwd, persistTo, vars, env = process.env }) {
  assert.ok(isAbsolute(cwd) && isAbsolute(persistTo), "Worker fixture paths must be absolute");
  return spawn(process.execPath, ["--import", new URL("./worker-runtime-observer.mjs", import.meta.url).href,
    join(cwd, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--ip", "127.0.0.1",
    "--config", "apps/worker/wrangler.jsonc", "--port", "0", "--inspector-port", "0", "--persist-to", persistTo,
    "--show-interactive-dev-session=false", ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`])], {
    cwd, env: { ...env, ...vars }, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true, windowsHide: true,
  });
}

/** Only handles created in detached fixture groups may be passed here. */
export async function stopFixtureProcess(child, afterExit = false) {
  if (child?.pid === undefined || (!afterExit && (child.exitCode !== null || child.signalCode !== null))) return;
  const deadline = Date.now() + 5_000;
  if (process.platform === "win32") {
    // No inherited pipes: taskkill is itself bounded by exit, not close.
    await new Promise((resolve, reject) => {
      const killer = spawn(resolveTrustedTaskkillPath(), ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => {
        try { killer.kill(); } catch { /* The termination deadline still applies. */ }
        killer.unref();
        finish(new Error("Fixture process tree termination timed out"));
      }, 5_000);
      killer.once("error", finish);
      killer.once("exit", code => finish(code === 0 ? undefined : new Error("Fixture process tree termination failed")));
    }).catch(error => { if (child.exitCode === null && child.signalCode === null) throw error; });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await delay(250);
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => {
      const exited = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.off("exit", exited); reject(new Error("Fixture process tree did not terminate")); }, Math.max(1, deadline - Date.now()));
      child.once("exit", exited);
      if (child.exitCode !== null || child.signalCode !== null) exited();
    });
  }
}

/** Wait only on a controlled detached fixture child; a timeout also owns cleanup. */
export function waitForFixtureExit(child, timeout, detail = () => "") {
  assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900_000);
  return new Promise((resolve, reject) => {
    let timer, settled = false, timingOut = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit); child.off("error", onError);
      error ? reject(error) : resolve();
    };
    const onExit = () => { if (!timingOut) finish(); };
    const onError = error => { if (!timingOut) finish(error); };
    child.once("exit", onExit); child.on("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) { finish(); return; }
    timer = setTimeout(() => {
      // Claim the timeout before terminating: the resulting exit is not success.
      timingOut = true;
      let output = "", diagnosticError;
      try { output = detail(); } catch (error) { diagnosticError = error; }
      const failure = new Error(`process did not exit after ${timeout}ms\n${output}`,
        diagnosticError === undefined ? undefined : { cause: diagnosticError });
      // Keep the error listener until tree cleanup ends and preserve the deadline
      // failure even when termination itself fails.
      void stopFixtureProcess(child, true).catch(error => { failure.cause ??= error; }).finally(() => finish(failure));
    }, timeout);
  });
}

/** Bound a private reporter subprocess and terminate its entire fixture group. */
export async function runFixtureCommand(file, args, { timeout, maxBuffer = 1024 * 1024, ...options }) {
  assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 900_000);
  assert.ok(Number.isSafeInteger(maxBuffer) && maxBuffer > 0);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
    const output = { stdout: { chunks: [], bytes: 0 }, stderr: { chunks: [], bytes: 0 } };
    let settled = false, failure, cleanupTimer;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(cleanupTimer);
      process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
      const result = Object.fromEntries(Object.entries(output).map(([name, stream]) => [name, Buffer.concat(stream.chunks, stream.bytes).toString("utf8")]));
      if (error) {
        // Descendants can retain stdout/stderr after the original PID exits.
        // Returning failure must never depend on receiving their close event.
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        error.code ??= child.exitCode; error.signal ??= child.signalCode;
        reject(Object.assign(error, result));
      } else resolve(result);
    };
    const fail = (error, reason) => {
      if (settled || failure) return;
      failure = error;
      error.termination_reason = reason;
      error.killed = reason !== undefined;
      clearTimeout(timer);
      // This deadline is independent of both close and tree-cleanup success.
      cleanupTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* Cleanup already failed; preserve the initiating error. */ }
        finish(error);
      }, 5_500);
      void stopFixtureProcess(child, true).catch(() => undefined).finally(() => finish(error));
    };
    const interrupt = () => fail(new Error("Fixture command interrupted"), "interrupted");
    const timer = setTimeout(() => fail(new Error("Fixture command timed out"), "timeout"), timeout);
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    for (const name of ["stdout", "stderr"]) child[name].on("data", chunk => {
      if (settled) return;
      const stream = output[name], remaining = maxBuffer - stream.bytes;
      if (remaining > 0) { const bounded = chunk.subarray(0, remaining); stream.chunks.push(bounded); stream.bytes += bounded.length; }
      if (chunk.length > remaining) fail(Object.assign(new Error("Fixture command output exceeded its limit"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), "output_limit");
    });
    child.once("error", error => fail(error));
    child.once("exit", (code, signal) => {
      if (code !== 0) fail(Object.assign(new Error("Fixture command failed"), { code, signal }));
    });
    child.once("close", (code, signal) => {
      if (failure || settled) return;
      if (code === 0) finish();
      else fail(Object.assign(new Error("Fixture command failed"), { code, signal }));
    });
  });
}

/** Wait for Wrangler's bound port over IPC, then probe the application under
 * one deadline. The child owns its port from bind(0) until fixture teardown. */
export function waitForWorker(child, timeout, detail = () => "") {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const deadline = performance.now() + timeout, maximumHealthBytes = 64 * 1024;
    let settled = false, checking = false, activeReader;
    const cancelReader = reader => {
      // Cleanup must not wait for the peer's cancellation acknowledgement.
      try { void reader.cancel().catch(() => undefined); } catch { /* Preserve the readiness failure. */ }
      try { reader.releaseLock(); } catch { /* A canceled reader may already be released. */ }
      if (activeReader === reader) activeReader = undefined;
    };
    const finish = (error, origin) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) {
        controller.abort();
        if (activeReader) cancelReader(activeReader);
        reject(error);
      } else resolve(origin);
    };
    const failure = message => {
      let output = "", diagnosticError;
      try { output = detail(); } catch (error) { diagnosticError = error; }
      return new Error(`${message}${output ? `\n${output}` : ""}`,
        diagnosticError === undefined ? undefined : { cause: diagnosticError });
    };
    const checkDeadline = () => {
      if (performance.now() >= deadline) throw failure(`timed out after ${timeout}ms`);
    };
    const onExit = (code, signal) => finish(failure(`Worker exited before readiness (code=${code}, signal=${signal})`));
    const onError = error => finish(failure(`Worker failed to start: ${error.message}`));
    const onMessage = message => {
      if (checking) return;
      if (typeof message === "string") {
        try { message = JSON.parse(message); } catch { return; }
      }
      if (message?.event !== "DEV_SERVER_READY") return;
      if (message.ip !== "127.0.0.1" || !Number.isInteger(message.port) || message.port < 1 || message.port > 65_535) {
        finish(failure("Worker reported an invalid loopback readiness address")); return;
      }
      checking = true;
      const origin = `http://127.0.0.1:${message.port}`;
      void (async () => {
        while (!controller.signal.aborted) {
          let reader;
          try {
            checkDeadline();
            const response = await fetch(`${origin}/health`, { signal: controller.signal });
            // Own late response bodies too, even if fetch settles after abort.
            reader = activeReader = response.body?.getReader();
            checkDeadline();
            if (settled) return;
            if (response.ok && reader) {
              let bytes = 0, emptyChunks = 0;
              while (true) {
                // Check wall time as well as the timer: already-resolved reads
                // can otherwise keep its callback from running.
                checkDeadline();
                const { done, value } = await reader.read();
                checkDeadline();
                if (settled) return;
                if (done) break;
                bytes += value.byteLength;
                emptyChunks = value.byteLength === 0 ? emptyChunks + 1 : 0;
                if (bytes > maximumHealthBytes || emptyChunks > 64) throw new Error("Worker health response exceeded its limit");
              }
              reader.releaseLock(); activeReader = undefined; reader = undefined;
            }
            if (response.ok) { finish(undefined, origin); return; }
          } catch (error) { if (controller.signal.aborted || performance.now() >= deadline) throw error; }
          finally { if (reader) cancelReader(reader); }
          await delay(100, undefined, { signal: controller.signal });
        }
      })().catch(error => finish(error));
    };
    const timer = setTimeout(() => finish(failure(`timed out after ${timeout}ms`)), timeout);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
  });
}
