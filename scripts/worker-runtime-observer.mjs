import childProcess from "node:child_process";
import { writeSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { isAbsolute, join } from "node:path";
import { isMainThread } from "node:worker_threads";

// Fixture-only preload: observe the pinned native runtime without retaining
// commands, arguments, paths, process IDs, environment or free-form errors.
const started = performance.now();
const installed = Symbol.for("runmesh.fixture.runtime.observer");
const signals = new Set(["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE", "SIGINT", "other"]);
function emit(marker, value) {
  try { writeSync(2, `${marker}${JSON.stringify(value)}\n`); }
  catch { /* Diagnostic output cannot change a fixture's outcome. */ }
}
function coverage(value) {
  emit("RUNMESH_E2E_RUNTIME_OBSERVER=", { event: "runtime_observer", coverage: value });
}
function observation(phase, runtimeIndex, code = null, signal = null) {
  emit("RUNMESH_E2E_RUNTIME_PROCESS=", {
    event: "runtime_process", phase, runtime_index: runtimeIndex,
    elapsed_ms: Math.min(900_000, Math.max(0, Math.round(performance.now() - started))),
    exit_code: code === null || (Number.isInteger(code) && code >= -2147483648 && code <= 4294967295) ? code : null,
    signal: signal === null ? null : signals.has(signal) ? signal : "other",
  });
}

function install() {
  if (globalThis[installed]) return;
  globalThis[installed] = true;
  if (!isMainThread) { coverage("worker_thread"); return; }
  if (process.env.MINIFLARE_WORKERD_PATH !== undefined) { coverage("runtime_override"); return; }
  let runtimeCommand;
  try {
    const wranglerRequire = createRequire(join(process.cwd(), "node_modules/wrangler/package.json"));
    const miniflareRequire = createRequire(wranglerRequire.resolve("miniflare"));
    runtimeCommand = miniflareRequire("workerd").default;
    if (typeof runtimeCommand !== "string" || !isAbsolute(runtimeCommand)) throw new Error();
  } catch { coverage("resolution_failed"); return; }

  const originalSpawn = childProcess.spawn;
  let observed = 0;
  childProcess.spawn = function runtimeObservedSpawn(...args) {
    const child = Reflect.apply(originalSpawn, this, args);
    if (args[0] !== runtimeCommand || observed >= 16) return child;
    const runtimeIndex = ++observed;
    try {
      child.once("spawn", () => observation("spawn", runtimeIndex));
      child.once("exit", (code, signal) => observation("exit", runtimeIndex, code, signal));
    } catch { /* Preserve the original return value if observation cannot attach. */ }
    return child;
  };
  syncBuiltinESMExports();
  coverage("installed");
}

install();
