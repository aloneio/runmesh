import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|WORKERS_CI|WRANGLER_CI_|CI_|GITHUB_)/u.test(key)));
const buildUuid = "12345678-1234-4234-8234-123456789abc";
const candidate = { version: "0.1.3", state: "candidate", release_branch: "main" };
function git(root, ...args) {
  return execFileSync("git", ["-c", "user.name=aloneio", "-c", "user.email=git@aloneio.aleeas.com", ...args], { cwd: root, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function fixture(t, state = { version: "0.1.3", state: "released", release_commit: "a".repeat(40), manifest_sha256: "b".repeat(64) }) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-deploy-proof-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  git(root, "init", "--initial-branch=main");
  for (const directory of ["scripts", "release", "apps/worker/src", "apps/worker/browser", "node_modules/wrangler/bin"]) await mkdir(join(root, directory), { recursive: true });
  for (const script of ["deploy-worker.mjs", "deployment-policy.mjs", "build-provenance.mjs", "generate-build-provenance.mjs", "prepare-worker-build.mjs", "generate-browser-assets.mjs"]) await copyFile(new URL(`../scripts/${script}`, import.meta.url), join(root, "scripts", script));
  await writeFile(join(root, ".gitignore"), "apps/worker/src/generated-provenance.ts*\napps/worker/src/generated-admin-client.ts*\n");
  await writeFile(join(root, "apps/worker/wrangler.jsonc"), JSON.stringify({ name: "runmesh", env: { production: { name: "runmesh" }, development: { name: "runmeshdev" } } }));
  await writeFile(join(root, "apps/worker/browser/admin-client.js"), "(function () {})();\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.3" }));
  await writeFile(join(root, "release/release-state.json"), JSON.stringify(state));
  await writeFile(join(root, "node_modules/wrangler/bin/wrangler.js"), 'console.log("FAKE_UPLOADER_REACHED", JSON.stringify(process.argv.slice(2)));\n');
  git(root, "add", "."); git(root, "commit", "-m", "Synthetic deployment fixture");
  const commit = git(root, "rev-parse", "HEAD");
  const invoke = (extra = {}) => spawnSync(process.execPath, [join(root, "scripts/deploy-worker.mjs"), "--env", "production"], {
    cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true,
    env: { ...environment, WORKERS_CI: "1", WORKERS_CI_BRANCH: "main", WORKERS_CI_COMMIT_SHA: commit, WORKERS_CI_BUILD_UUID: buildUuid, ...extra },
  });
  return { root, commit, invoke };
}

test("R01 actual deployment wrapper tags clean source without runtime variables", async t => {
  const f = await fixture(t); const result = f.invoke();
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /FAKE_UPLOADER_REACHED/u);
  assert.ok(result.stdout.includes(`main:${f.commit}`)); assert.ok(!result.stdout.includes("--var"));
  assert.ok(result.stdout.includes('"--name","runmesh"'));
  assert.equal(git(f.root, "status", "--porcelain"), "");
});

test("candidate Workers Builds completes source checks while preserving the active production Worker", async t => {
  const f = await fixture(t, candidate);
  // Cloudflare can check out a detached commit; its complete metadata still
  // binds the intentional no-upload result to main and the exact source.
  git(f.root, "checkout", "--detach");
  const result = f.invoke({ WRANGLER_CI_OVERRIDE_NAME: "runmesh" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes("FAKE_UPLOADER_REACHED"));
  assert.deepEqual(JSON.parse(result.stdout), {
    action: "production_preserved", uploaded: false, reason: "awaiting_verified_release",
    deployment: { environment: "production", branch: "main", worker: "runmesh" },
    source_commit: f.commit, source_tree: git(f.root, "rev-parse", "HEAD^{tree}"),
  });
  assert.equal(git(f.root, "status", "--porcelain"), "");
});

test("candidate preservation cannot turn manual, incomplete or conflicting deployment preflight into success", async t => {
  const f = await fixture(t, candidate);
  const reject = result => {
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes("FAKE_UPLOADER_REACHED"));
    assert.ok(!result.stdout.includes("production_preserved"));
  };
  for (const extra of [
    { WORKERS_CI: "", WORKERS_CI_BRANCH: "", WORKERS_CI_COMMIT_SHA: "", WORKERS_CI_BUILD_UUID: "" },
    { WORKERS_CI_BUILD_UUID: "" }, { WORKERS_CI_BRANCH: "" }, { WORKERS_CI_COMMIT_SHA: "" },
    { WORKERS_CI_BUILD_UUID: "not-a-build-uuid" }, { WORKERS_CI_COMMIT_SHA: "a".repeat(40) },
    { CI_COMMIT_SHA: "b".repeat(40) }, { WORKERS_CI_BRANCH: "dev" },
    { CI_MERGE_REQUEST_IID: "42" }, { WRANGLER_CI_OVERRIDE_NAME: "runmeshdev" },
  ]) reject(f.invoke(extra));
  await writeFile(join(f.root, "untracked-source.ts"), "unreviewed content\n");
  reject(f.invoke());
});

test("candidate Workers Builds rejects malformed release records before reaching the uploader", async t => {
  for (const state of [{ ...candidate, version: "0.1.2" }, { ...candidate, release_commit: "a".repeat(40) }]) {
    const f = await fixture(t, state), result = f.invoke();
    assert.notEqual(result.status, 0);
    assert.ok(!result.stdout.includes("FAKE_UPLOADER_REACHED"));
    assert.ok(!result.stdout.includes("production_preserved"));
  }
});

test("R01 actual deployment wrapper rejects inconsistent or untracked source before upload", async t => {
  const f = await fixture(t);
  for (const extra of [{ WRANGLER_CI_OVERRIDE_NAME: "runmeshdev" }, { WORKERS_CI_COMMIT_SHA: "a".repeat(40) }, { CI_COMMIT_SHA: "b".repeat(40) }, { WORKERS_CI_BRANCH: "dev" }]) {
    const result = f.invoke(extra); assert.notEqual(result.status, 0); assert.ok(!result.stdout.includes("FAKE_UPLOADER_REACHED"));
  }
  await writeFile(join(f.root, "untracked-source.ts"), "unreviewed content\n");
  const dirty = f.invoke(); assert.notEqual(dirty.status, 0); assert.ok(!dirty.stdout.includes("FAKE_UPLOADER_REACHED"));
});

test("R01 configured Wrangler hook works from both repository and Worker directories", async t => {
  const f = await fixture(t);
  const config = JSON.parse(await readFile(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8"));
  for (const cwd of [f.root, join(f.root, "apps/worker")]) {
    const result = spawnSync(config.build.command, { cwd, env: environment, shell: true, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(f.commit));
  }
});

test("R01 failed deployment preflight does not echo private branch metadata or exception stacks", async t => {
  const f = await fixture(t);
  const result = f.invoke({ WORKERS_CI_BRANCH: "private-branch-do-not-publish" });
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes("FAKE_UPLOADER_REACHED"));
  assert.ok(!`${result.stdout}${result.stderr}`.includes("private-branch-do-not-publish"));
  assert.ok(!result.stderr.includes("AssertionError"));
});
