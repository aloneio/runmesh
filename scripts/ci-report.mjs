import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sourceGitEnvironment, sourceIndexProblem, sourceDirectoryIdentity, sameDirectoryIdentity } from "./source-git.mjs";
import { writeCiEvidenceFile } from "./evidence-io.mjs";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export function sourceObservation(root = ROOT) {
  try {
    const env = sourceGitEnvironment(), identity = sourceDirectoryIdentity(root);
    const git = (...args) => execFileSync("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], { cwd: root, env, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
    assert.ok(sameDirectoryIdentity(identity, sourceDirectoryIdentity(git("rev-parse", "--show-toplevel"))), "source root differs from checkout");
    const commit = git("rev-parse", "HEAD"); assert.match(commit, /^[a-f0-9]{40}$/u);
    const tree = git("rev-parse", `${commit}^{tree}`); assert.match(tree, /^[a-f0-9]{40}$/u);
    assert.equal(sourceIndexProblem(git), undefined, "source index cannot establish a visible checkout");
    const state = git("status", "--porcelain", "--untracked-files=all") === "" ? "clean" : "dirty";
    // A checkout change must not combine one commit with another tree/status.
    assert.equal(git("rev-parse", "HEAD"), commit, "source changed during observation");
    assert.ok(sameDirectoryIdentity(identity, sourceDirectoryIdentity(root)), "source root changed during observation");
    return { commit, tree, state };
  } catch { return { commit: null, tree: null, state: "unknown" }; }
}

/** Recheck commit, tree and checkout state before publishing successful evidence.
 * Dirty/unknown observations remain local observations, not clean-source proof. */
export function assertSourceObservationUnchanged(source, root = ROOT) {
  assert.deepEqual(sourceObservation(root), source, "source observation changed during verification");
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
  assert.match(report.gate, /^[a-z][a-z0-9_]{0,63}$/u);
  for (const [extension, body] of [["json", JSON.stringify(report, null, 2) + "\n"], ["xml", gateJUnit(report)]]) {
    await writeCiEvidenceFile(root, `${report.gate}.${extension}`, body);
  }
}
