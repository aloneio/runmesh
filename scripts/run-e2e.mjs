import { execFile, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTrustedTaskkillPath } from "./windows-tools.mjs";

// Invoke Vitest through the current Node executable so the command works on
// POSIX shells and Windows cmd/PowerShell alike (where npm scripts cannot use
// a leading `NAME=value` assignment).
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = resolve(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const taskkill = process.platform === "win32" ? resolveTrustedTaskkillPath() : undefined;
const child = spawn(process.execPath, [vitest, "run", "--config", "vitest.e2e.config.ts"], {
  cwd: repositoryRoot,
  env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" },
  // Put Vitest and any Wrangler/tsx children in a separate process group so a
  // timeout or interrupted release gate cannot leave a worker running.
  detached: true,
  stdio: "inherit",
});
const timeoutValue = Number.parseInt(process.env.RUNMESH_E2E_TIMEOUT_MS ?? "300000", 10);
const timeoutMs = Number.isSafeInteger(timeoutValue) && timeoutValue > 0 && timeoutValue <= 900000 ? timeoutValue : 300000;
let timedOut = false;
let interrupted = false;
let stopping = false;
let childExited = false;
let stopTimer;
let forceExitTimer;
const timeoutTimer = setTimeout(() => {
  timedOut = true;
  process.stderr.write(`E2E tests did not finish within ${timeoutMs} ms.\n`);
  requestStop();
}, timeoutMs);

child.once("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  childExited = true;
  clearTimeout(timeoutTimer);
  clearTimeout(stopTimer);
  clearTimeout(forceExitTimer);
  if (signal !== null || timedOut || interrupted) process.exitCode = 1;
  else process.exitCode = code ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    requestStop();
  });
}

function requestStop() {
  if (stopping || child.pid === undefined) return;
  stopping = true;
  // Give Vitest a short opportunity to flush its final output before the
  // process-tree termination. The hard timeout remains bounded if it ignores
  // the signal or leaves descendants behind.
  stopTimer = setTimeout(() => {
    terminateTree(child.pid).catch((error) => {
      process.stderr.write(`failed to terminate E2E process tree: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, 100);
}

async function terminateTree(pid) {
  if (process.platform === "win32") {
    if (taskkill === undefined) throw new Error("trusted Windows taskkill path is unavailable");
    await new Promise((resolvePromise) => {
      execFile(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, () => resolvePromise());
    });
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { /* process already exited */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    try { process.kill(-pid, "SIGKILL"); } catch { /* process already exited */ }
  }
  // Do not let an unexpectedly unkillable child hold the release gate forever.
  if (!childExited) {
    forceExitTimer = setTimeout(() => {
      process.stderr.write("E2E process tree did not terminate cleanly.\n");
      process.exit(1);
    }, 5000);
  }
}
