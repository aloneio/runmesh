import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|WORKERS_CI|WRANGLER_CI_|CI_|GITHUB_)/u.test(key)));
const buildUuid = "12345678-1234-4234-8234-123456789abc";
const candidate = { version: "0.1.3", state: "candidate", release_branch: "main" };
const project = fileURLToPath(new URL("../", import.meta.url));
function git(root, ...args) {
  return execFileSync("git", ["-c", "user.name=aloneio", "-c", "user.email=git@aloneio.aleeas.com", ...args], { cwd: root, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function fixture(t, state = { version: "0.1.3", state: "released", release_commit: "a".repeat(40), manifest_sha256: "b".repeat(64) }, approved = false) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-deploy-proof-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  git(root, "init", "--initial-branch=main");
  for (const directory of ["scripts", "release", "apps/worker/src", "apps/worker/browser", "node_modules/wrangler/bin"]) await mkdir(join(root, directory), { recursive: true });
  for (const script of ["deploy-worker.mjs", "deployment-policy.mjs", "production-approval-policy.mjs", "production-approval-gitlab.mjs", "build-provenance.mjs", "source-git.mjs", "generate-build-provenance.mjs", "prepare-worker-build.mjs", "generate-browser-assets.mjs", "architecture-graph.mjs", "architecture-policy.mjs", "central-architecture-policy.mjs"]) await copyFile(new URL(`../scripts/${script}`, import.meta.url), join(root, "scripts", script));
  // Exercise the real bounded bundler; only the deployment uploader is fake.
  for (const dependency of ["esbuild", "@babel"])
    await symlink(join(project, "node_modules", dependency), join(root, "node_modules", dependency), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(root, ".gitignore"), "apps/worker/src/generated-provenance.ts*\napps/worker/src/generated-admin-client.ts*\nnode_modules/esbuild\nnode_modules/@babel\n");
  await writeFile(join(root, "apps/worker/wrangler.jsonc"), JSON.stringify({ name: "runmesh", env: { production: { name: "runmesh" }, development: { name: "runmeshdev" } } }));
  await writeFile(join(root, "apps/worker/browser/admin-client.js"), "(function () {})();\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.3" }));
  await writeFile(join(root, "release/release-state.json"), JSON.stringify(state));
  await writeFile(join(root, "node_modules/wrangler/bin/wrangler.js"), 'console.log("FAKE_UPLOADER_REACHED", JSON.stringify(process.argv.slice(2)));\n');
  git(root, "add", "."); git(root, "commit", "-m", "Synthetic deployment fixture");
  const commit = git(root, "rev-parse", "HEAD");
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  const stubDir = await mkdtemp(join(tmpdir(), "runmesh-approved-glab-"));
  t.after(() => rm(stubDir, { recursive: true, force: true }));
  const stubPath = join(stubDir, process.platform === "win32" ? "glab.cmd" : "glab");
  const main = { id: 101, project_id: 85844627, sha: commit, ref: "main", source: "push", status: "success" };
  const merge = { id: 102, project_id: 85844627, sha: commit, ref: "refs/merge-requests/86/head",
    source: "merge_request_event", status: "success" };
  const jobs = (names, pipeline, offset) => names.map((name, i) => ({
    id: offset + i, name, status: "success", allow_failure: false,
    pipeline: { id: pipeline.id, sha: pipeline.sha },
  }));
  const artifact = gate => ({
    schema_version: 1, evidence: "ci_gate_execution", gate,
    state: "passed", exit_code: 0,
    source: { commit, tree, state: "clean" },
  });
  const base = "projects/85844627";
  const responses = Object.fromEntries([
    [base, { id: 85844627, path_with_namespace: "aloneio/runmesh", default_branch: "main",
      merge_method: "ff", only_allow_merge_if_pipeline_succeeds: true,
      allow_merge_on_skipped_pipeline: false,
      ci_config_path: ".gitlab/main-policy.yml@aloneio/runmesh:main",
      ci_pipeline_variables_minimum_override_role: "no_one_allowed" }],
    [base + "/repository/branches/main", { name: "main", protected: true, commit: { id: commit } }],
    [base + "/protected_branches?per_page=100", [
      { name: "main", allow_force_push: false,
        push_access_levels: [{ access_level: 0 }], merge_access_levels: [{ access_level: 40 }] },
      { name: "dev", allow_force_push: false,
        push_access_levels: [{ access_level: 30 }], merge_access_levels: [{ access_level: 30 }] },
      { name: "runmesh-trusted-release-*", allow_force_push: false,
        push_access_levels: [{ access_level: 0 }], merge_access_levels: [{ access_level: 0 }] },
    ]],
    [base + `/pipelines?ref=main&sha=${commit}&per_page=100`, [main]],
    [base + "/pipelines/101", main],
    [base + "/pipelines/101/jobs?per_page=100", jobs(["privacy-policy", "verify", "browser"], main, 1)],
    [base + `/repository/commits/${commit}/merge_requests`, [{
      iid: 86, sha: commit, state: "merged", source_branch: "dev", target_branch: "main",
      source_project_id: 85844627, target_project_id: 85844627,
      merged_at: "2026-10-16T10:43:50Z", squash: false,
    }]],
    [base + "/merge_requests/86/pipelines?per_page=100", [merge]],
    [base + "/pipelines/102", merge],
    [base + "/pipelines/102/jobs?per_page=100",
      jobs(["main-source-policy", "privacy-policy", "verify", "browser"], merge, 4)],
    [base + "/jobs/2/artifacts/ci-results/unit.json", artifact("unit")],
    [base + "/jobs/2/artifacts/ci-results/installed_transport.json", artifact("installed_transport")],
    [base + "/jobs/3/artifacts/ci-results/browser.json", artifact("browser")],
  ]);
  const sourceChangePath = join(root, "apps/worker/browser/admin-client.js");
  const fakeGlabSource = `const responses = ${JSON.stringify(responses)};
const rawPath = process.argv[3] ?? "";
const path = rawPath.replaceAll(String.fromCharCode(34), "").trim();
if (process.env.RUNMESH_TEST_CHANGE_SOURCE === "1" && path.endsWith("/ci-results/browser.json")) {
  require("node:fs").writeFileSync(${JSON.stringify(sourceChangePath)}, "source changed after approval");
}
if (${JSON.stringify(approved)} && Object.prototype.hasOwnProperty.call(responses, path)) {
  process.stdout.write(JSON.stringify(responses[path]) + "\\n");
} else { process.exitCode = 1; }
`;
  const fakeGlab = process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "%~dp0glab-stub.cjs" "%~1" "%~2"\r\n`
    : `#!/usr/bin/env node\n${fakeGlabSource}`;
  if (process.platform === "win32") await writeFile(join(stubDir, "glab-stub.cjs"), fakeGlabSource);
  await writeFile(stubPath, fakeGlab, { mode: 0o755 });
  const searchPath = stubDir + delimiter + (environment.PATH ?? environment.Path ?? process.env.PATH ?? process.env.Path ?? "");
  const invoke = (extra = {}) => spawnSync(process.execPath, [join(root, "scripts/deploy-worker.mjs"), "--env", "production"], {
    cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true,
    env: { ...environment, PATH: searchPath, Path: searchPath,
      PATHEXT: environment.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      WORKERS_CI: "1", WORKERS_CI_BRANCH: "main", WORKERS_CI_COMMIT_SHA: commit,
      WORKERS_CI_BUILD_UUID: buildUuid, ...extra },
  });
  return { root, commit, invoke };
}

test("R01 actual deployment wrapper tags clean approved source without runtime variables", async t => {
  const f = await fixture(t, undefined, true); const result = f.invoke();
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /FAKE_UPLOADER_REACHED/u);
  assert.ok(result.stdout.includes(`main:${f.commit}`)); assert.ok(!result.stdout.includes("--var"));
  assert.ok(result.stdout.includes('"--name","runmesh"'));
  assert.equal(git(f.root, "status", "--porcelain"), "");
});

test("a source edit during a successful approval prevents the Wrangler upload", async t => {
  const f = await fixture(t, undefined, true);
  const result = f.invoke({ RUNMESH_TEST_CHANGE_SOURCE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deployment_source_changed/);
  assert.ok(!result.stdout.includes("FAKE_UPLOADER_REACHED"));
});

test("production release without independent approved GitLab evidence never reaches Wrangler", async t => {
  const f = await fixture(t);
  const result = f.invoke();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production_approval_denied/);
  assert.ok(!result.stdout.includes("FAKE_UPLOADER_REACHED"));
  assert.ok(!result.stderr.includes("Cannot find module"));
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

test("production approval names the Windows GitLab CLI wrapper explicitly", async () => {
  const source = await readFile(new URL("../scripts/production-approval-gitlab.mjs", import.meta.url), "utf8");
  assert.match(source, /process\.platform === "win32" \? "glab\.cmd" : "glab"/u);
});
