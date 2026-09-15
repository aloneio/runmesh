import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { CI_CHECKS, CHECK_IDS } from "./ci-contract.mjs";
import { ROOT, gateEvidence, sourceObservation, writeGateReport } from "./ci-report.mjs";
import { packageEvidence } from "./test-evidence.mjs";
import { writeSupplement } from "./ci-supplement.mjs";
import { resolveTrustedTaskkillPath } from "./windows-tools.mjs";

const id = process.argv[2];
assert.ok(process.argv.length === 3 && Object.hasOwn(CI_CHECKS, id), "Use one declared CI gate ID");
const source = sourceObservation(), started = Date.now();
if (id === "toolchain") {
  for (const name of CHECK_IDS) await writeGateReport(gateEvidence(name, "not_run", 0, null, source));
  for (const name of ["package-e2e", "browser-tests", "crossforge-evidence"]) await writeSupplement(name, { schema_version: 1, state: "not_run", source });
}
await writeGateReport(gateEvidence(id, "running", 0, null, source));
if (id === "installed_transport") await writeSupplement("package-e2e", { schema_version: 1, state: "not_run", source });
const [program, ...args] = CI_CHECKS[id].split(" ");
const executable = program === "node" ? process.execPath : program === "npm" && process.platform === "win32" ? "npm.cmd" : program;
const child = spawn(executable, args, { cwd: ROOT, stdio: "inherit", detached: process.platform !== "win32", shell: program === "npm" && process.platform === "win32", windowsHide: true });
let reason, killTimer;
const kill = async () => {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const path = resolveTrustedTaskkillPath();
    if (path) await promisify(execFile)(path, ["/PID", String(child.pid), "/T", "/F"], { timeout: 5000, windowsHide: true }).catch(() => undefined);
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already closed */ }
    killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already closed */ } }, 1000);
  }
};
const interrupted = () => { reason = "cancelled"; void kill(); };
process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
const timer = setTimeout(() => { reason = "timed_out"; void kill(); }, id === "installed_transport" ? 480000 : 600000);
let code;
try {
  code = await new Promise(resolve => { child.once("error", () => resolve(1)); child.once("close", value => resolve(value ?? 1)); });
} finally {
  clearTimeout(timer); clearTimeout(killTimer);
  process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted);
}
try {
  if (id === "installed_transport" && code === 0 && !reason) {
    const path = join(ROOT, ".verification/package-e2e.json"), info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size < 65536);
    const input = JSON.parse(await readFile(path, "utf8"));
    const safe = packageEvidence({ tests: input.tests, source: input.source, artifact: input.artifact, ...input.runtime, node: input.runtime.node, elapsedMs: input.elapsed_ms });
    assert.equal(safe.source.commit, source.commit, "package evidence belongs to a different source");
    // Validate/project rather than copy an arbitrary hidden directory.
    await writeSupplement("package-e2e", safe);
  }
} catch { code = 1; }
await writeGateReport(gateEvidence(id, reason ?? (code === 0 ? "passed" : "failed"), Date.now() - started, code, source));
process.exitCode = reason ? 1 : code;
