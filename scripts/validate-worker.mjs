import { execFile, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTrustedTaskkillPath } from "./windows-tools.mjs";

// Wrangler's dry-run handler can return while its Windows esbuild service is
// still keeping the Node event loop alive. Invoke the checked-in CLI directly
// and terminate its complete process tree once Wrangler has printed its
// successful dry-run marker. This keeps local and CI validation bounded on all
// host platforms without treating an arbitrary timeout as success.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = resolve(repositoryRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const taskkill = process.platform === "win32" ? resolveTrustedTaskkillPath() : undefined;
const extraArgs = process.argv.slice(2);
for (let index = 0; index < extraArgs.length; index += 1) {
  const arg = extraArgs[index];
  if (arg === "--no-dry-run" || /^--dry-run=(?!true$)/iu.test(arg)) {
    throw new Error("validate:worker always runs Wrangler in dry-run mode");
  }
  // Wrangler's boolean parser also accepts a value in the following token.
  // Reject every explicit non-true value so `--dry-run false` cannot turn the
  // wrapper into a real deployment. A following option is not a value.
  if (arg === "--dry-run") {
    const next = extraArgs[index + 1];
    if (next !== undefined && !next.startsWith("-") && !/^true$/iu.test(next)) {
      throw new Error("validate:worker always runs Wrangler in dry-run mode");
    }
    if (next !== undefined && /^true$/iu.test(next)) index += 1;
  }
}
const hasFlag = (name) => extraArgs.some((arg) => arg === name || arg.startsWith(`${name}=`));
const args = [
  "deploy",
  "--dry-run",
  ...(hasFlag("--config") || hasFlag("-c") ? [] : ["--config", resolve(repositoryRoot, "apps/worker/wrangler.jsonc")]),
  ...extraArgs,
];
const timeoutValue = Number.parseInt(process.env.RUNMESH_VALIDATE_WORKER_TIMEOUT_MS ?? "180000", 10);
const timeoutMs = Number.isSafeInteger(timeoutValue) && timeoutValue > 0 && timeoutValue <= 900000 ? timeoutValue : 180000;
const successMarker = "--dry-run: exiting now.";
const child = spawn(process.execPath, [wrangler, ...args], {
  cwd: repositoryRoot,
  env: { ...process.env },
  detached: true,
  stdio: ["inherit", "pipe", "pipe"],
  windowsHide: true,
});

let markerSeen = false;
let timedOut = false;
let interrupted = false;
let spawnFailed = false;
let stopping = false;
let childExited = false;
let outputTail = "";
let stopTimer;
let timeoutTimer;
let forceExitTimer;

function forward(stream, chunk) {
  const text = chunk.toString();
  stream.write(text);
  outputTail = `${outputTail}${text}`.slice(-(successMarker.length + 32));
  if (!markerSeen && outputTail.includes(successMarker)) {
    markerSeen = true;
    requestStop();
  }
}

child.stdout.on("data", (chunk) => forward(process.stdout, chunk));
child.stderr.on("data", (chunk) => forward(process.stderr, chunk));
child.once("error", (error) => {
  spawnFailed = true;
  clearTimeout(timeoutTimer);
  if (!markerSeen) clearTimeout(stopTimer);
  process.stderr.write(`failed to start Wrangler: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    requestStop();
  });
}

timeoutTimer = setTimeout(() => {
  timedOut = true;
  process.stderr.write(`Wrangler dry-run did not finish within ${timeoutMs} ms.\n`);
  requestStop();
}, timeoutMs);

child.once("exit", (code, signal) => {
  childExited = true;
  clearTimeout(timeoutTimer);
  // Keep the post-marker stop timer alive even if Wrangler's parent exits
  // quickly: its detached esbuild/service descendants can outlive the parent
  // and still need the process-tree cleanup promised by this validator.
  if (!markerSeen) clearTimeout(stopTimer);
  clearTimeout(forceExitTimer);
  if (timedOut || interrupted || spawnFailed) {
    process.exitCode = 1;
  } else if (markerSeen && !interrupted && !spawnFailed) {
    // Wrangler may report success and then be terminated solely to release a
    // leaked esbuild child. Preserve the successful dry-run result.
    process.exitCode = 0;
  } else if (code === 0 && signal === null) {
    // A zero exit without Wrangler's explicit dry-run marker is not proof that
    // the deployment was validated (output formats can change or a wrapper
    // can terminate early). Fail closed instead of turning an incomplete probe
    // into a release approval.
    process.stderr.write("Wrangler exited without its successful dry-run marker.\n");
    process.exitCode = 1;
  } else if (signal !== null) {
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});

function requestStop() {
  if (stopping || child.pid === undefined) return;
  stopping = true;
  // Give Wrangler a short opportunity to flush its final output before the
  // process-tree termination. The hard timeout remains bounded if it ignores
  // the signal or leaves descendants behind.
  stopTimer = setTimeout(() => {
    terminateTree(child.pid).catch((error) => {
      process.stderr.write(`failed to terminate Wrangler process tree: ${error instanceof Error ? error.message : String(error)}\n`);
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
      process.stderr.write("Wrangler process tree did not terminate cleanly.\n");
      process.exit(1);
    }, 5000);
  }
}
