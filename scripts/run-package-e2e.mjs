import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeVitest, packageEvidence } from "./test-evidence.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const reportDir = join(root, ".verification");
const reportPath = join(reportDir, "package-e2e.json");
const started = Date.now();
let temp, phase = "preflight", reportReady = false;
async function command(file, args, timeout = 120000, env = process.env) {
  return exec(file, args, { cwd: root, env, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}
async function sourceIdentity() {
  const git = async (...args) => (await command("git", ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", ...args], 10000)).stdout.trim();
  const commit = await git("rev-parse", "HEAD"), tree = await git("rev-parse", "HEAD^{tree}");
  assert.match(commit, /^[a-f0-9]{40}$/u); assert.match(tree, /^[a-f0-9]{40}$/u);
  for (const declared of [process.env.GITHUB_SHA, process.env.CI_COMMIT_SHA]) if (declared) assert.equal(declared, commit, "CI source differs from checkout");
  return { commit, tree, state: await git("status", "--porcelain", "--untracked-files=all") === "" ? "clean" : "dirty" };
}
async function writeReport(value) {
  const path = join(reportDir, `${randomUUID()}.tmp`);
  try { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); await rename(path, reportPath); }
  finally { await rm(path, { force: true }); }
}
try {
  assert.equal(process.argv.length, 2, "Use npm run test:package:e2e without arbitrary arguments");
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(reportDir); assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  reportReady = true;
  await writeReport({ schema_version: 1, evidence: "local_packaged_runner_e2e", state: "not_run", phase });
  const source = await sourceIdentity();
  const npm = process.env.npm_execpath;
  assert.ok(npm && isAbsolute(npm) && basename(npm) === "npm-cli.js", "Run through the installed npm CLI");
  temp = await mkdtemp(join(tmpdir(), "runmesh-ar08-package-"));
  phase = "pack";
  await command(process.execPath, [npm, "pack", "--workspace=@aloneio/runmesh-runner", "--json", "--pack-destination", temp]);
  // npm lifecycle scripts can prepend ordinary text even with --json. The
  // fresh private output directory, not human-oriented stdout, owns the asset.
  const archives = (await readdir(temp)).filter(name => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "exactly one generated archive is required");
  const filename = archives[0]; assert.match(filename, /^[A-Za-z0-9._-]+\.tgz$/u);
  const archive = join(temp, filename), stat = await lstat(archive);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 8 * 1024 * 1024);
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const artifact = { sha256: digest(await readFile(archive)), bytes: stat.size };
  phase = "installed_package_e2e";
  const rawReport = join(temp, "vitest.json");
  const result = await command(process.execPath, [join(root, "scripts/test-packed-runner.mjs"), archive], 420000,
    { ...process.env, RUNMESH_TEST_RESULT_PATH: rawReport });
  // Retain existing detailed test logs in CI, but never copy their contents
  // into the shareable report. Synthetic diagnostic fixtures are not evidence.
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  const info = await lstat(rawReport); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024);
  const tests = summarizeVitest(JSON.parse(await readFile(rawReport, "utf8")), 0);
  assert.equal(digest(await readFile(archive)), artifact.sha256, "archive changed during verification");
  assert.deepEqual(await sourceIdentity(), source, "source changed during verification");
  const report = packageEvidence({ tests, source, artifact, platform: process.platform, arch: process.arch, node: process.version, elapsedMs: Date.now() - started });
  await writeReport(report);
  console.log(JSON.stringify(report));
  console.log("AR08_PACKAGED_E2E_VERIFIED");
} catch {
  // No old successful report survives a failed attempt. Do not print raw
  // subprocess exceptions, filesystem paths or credential-bearing logs here.
  if (reportReady) await writeReport({ schema_version: 1, evidence: "local_packaged_runner_e2e", state: "failed", phase }).catch(() => undefined);
  console.error(`packaged_e2e_failed: ${phase}; inspect the test job, not a previous report`);
  process.exitCode = 1;
} finally { if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
