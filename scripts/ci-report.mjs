import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export function sourceObservation(root = ROOT) {
  try {
    const git = (...args) => execFileSync("git", ["--no-optional-locks", "--no-replace-objects", ...args], { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
    assert.match(commit, /^[a-f0-9]{40}$/u); assert.match(tree, /^[a-f0-9]{40}$/u);
    return { commit, tree, state: git("status", "--porcelain", "--untracked-files=all") === "" ? "clean" : "dirty" };
  } catch { return { commit: null, tree: null, state: "unknown" }; }
}

export function gateEvidence(id, state, elapsedMs, exitCode, source) {
  assert.match(id, /^[a-z][a-z0-9_]{0,63}$/u);
  assert.ok(["not_run", "running", "passed", "failed", "timed_out", "cancelled"].includes(state));
  assert.ok(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0);
  assert.ok(exitCode === null || Number.isSafeInteger(exitCode));
  assert.ok(state !== "passed" || exitCode === 0, "failed process cannot be passed");
  assert.ok(source && ["clean", "dirty", "unknown"].includes(source.state));
  for (const key of ["commit", "tree"]) assert.ok(source[key] === null || typeof source[key] === "string" && /^[a-f0-9]{40}$/u.test(source[key]), "invalid source identity");
  return { schema_version: 1, evidence: "ci_gate_execution", attestation: "self_reported", gate: id, state,
    observed_at: new Date().toISOString(), elapsed_ms: elapsedMs, exit_code: exitCode,
    source: { commit: source.commit, tree: source.tree, state: source.state },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    test_counts: null, // A gate process is not a count of its semantic assertions.
    signed_release: "not_run", production: "not_run", account_quotas: "not_run" };
}

export function gateJUnit(report) {
  const failure = ["failed", "timed_out", "cancelled"].includes(report.state);
  const skipped = ["running", "not_run"].includes(report.state);
  // Identifiers are fixed safe gate names; never include exception text, paths,
  // commands, raw test titles, stdout, environment or secret-bearing fixtures.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="runmesh-ci-gates" tests="1" failures="${failure ? 1 : 0}" skipped="${skipped ? 1 : 0}"><testcase classname="ci.gate" name="${report.gate}" time="${report.elapsed_ms / 1000}">${failure ? `<failure type="${report.state}" message="See the restricted CI job log; execution did not pass."/>` : skipped ? `<skipped message="${report.state}"/>` : ""}</testcase></testsuite>\n`;
}

export async function writeGateReport(report, root = ROOT) {
  const directory = join(root, "ci-results");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink(), "unsafe report directory");
  assert.match(report.gate, /^[a-z][a-z0-9_]{0,63}$/u);
  for (const [extension, body] of [["json", JSON.stringify(report, null, 2) + "\n"], ["xml", gateJUnit(report)]]) {
    const target = join(directory, `${report.gate}.${extension}`), temporary = join(directory, `${randomUUID()}.tmp`);
    const old = await lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; });
    assert.ok(old === undefined || old.isFile() && !old.isSymbolicLink(), "unsafe existing report");
    try { await writeFile(temporary, body, { flag: "wx", mode: 0o600 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
}
