import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureBuildProvenance, writeBuildProvenance, sourceDirectoryIdentity, sameDirectoryIdentity } from "../scripts/build-provenance.mjs";

const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
function git(root, ...args) {
  return execFileSync("git", ["-c", "user.name=aloneio", "-c", "user.email=git@aloneio.aleeas.com", ...args], { cwd: root, env: gitEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  git(root, "init", "--initial-branch=main");
  await mkdir(join(root, "apps/worker/src"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "apps/worker/src/generated-provenance.ts*\n");
  await writeFile(join(root, "source.txt"), "tracked source\n");
  git(root, "add", "."); git(root, "commit", "-m", "Synthetic source fixture");
  return { root, commit: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") };
}

test("R01 clean source reports its actual Git commit and tree without a runtime tag", async t => {
  const f = await fixture(t);
  assert.deepEqual(captureBuildProvenance(f.root, {}), { schema_version: 1, state: "clean", commit: f.commit, tree: f.tree, branch: "main", reason: null });
});

test("R01 detached Cloudflare builds validate both declared commit and branch", async t => {
  const f = await fixture(t); git(f.root, "checkout", "--detach");
  assert.equal(captureBuildProvenance(f.root, {}).branch, null);
  assert.equal(captureBuildProvenance(f.root, { WORKERS_CI: "1", WORKERS_CI_COMMIT_SHA: f.commit, WORKERS_CI_BRANCH: "main" }).branch, "main");
  for (const env of [
    { WORKERS_CI_COMMIT_SHA: "a".repeat(40), WORKERS_CI_BRANCH: "main" },
    { WORKERS_CI_COMMIT_SHA: "not-a-commit", WORKERS_CI_BRANCH: "main" },
    { WORKERS_CI_COMMIT_SHA: f.commit, CI_COMMIT_SHA: "a".repeat(40) },
    { WORKERS_CI_BRANCH: "main", CI_COMMIT_BRANCH: "dev" },
  ]) assert.equal(captureBuildProvenance(f.root, env).state, "conflict");
  assert.equal(captureBuildProvenance(f.root, { WORKERS_CI_BRANCH: "main" }).branch, null, "a branch label without matching CI commit is not provenance");
});

test("R01 PR/MR builds keep the exact tested commit but never claim to be main", async t => {
  const f = await fixture(t); git(f.root, "checkout", "--detach");
  for (const env of [
    { GITHUB_SHA: f.commit, GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" },
    { CI_COMMIT_SHA: f.commit, CI_MERGE_REQUEST_IID: "1", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main" },
    { GITHUB_SHA: f.commit, GITHUB_REF: "refs/tags/v0.1.3" },
  ]) assert.deepEqual(captureBuildProvenance(f.root, env), { schema_version: 1, state: "clean", commit: f.commit, tree: f.tree, branch: null, reason: null });
});

test("R01 tracked, staged and untracked edits cannot reuse a clean source identity", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "source.txt"), "changed\n");
  assert.equal(captureBuildProvenance(f.root, {}).state, "dirty");
  git(f.root, "add", "source.txt"); assert.equal(captureBuildProvenance(f.root, {}).commit, null);
  git(f.root, "reset", "--hard", "HEAD"); await writeFile(join(f.root, "new-source.ts"), "new source\n");
  assert.equal(captureBuildProvenance(f.root, {}).state, "dirty");
});

test("R01 assume-unchanged and skip-worktree cannot hide source edits", async t => {
  const f = await fixture(t);
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    git(f.root, "update-index", `--${flag}`, "source.txt");
    assert.equal(captureBuildProvenance(f.root, {}).state, "unavailable");
    git(f.root, "update-index", `--no-${flag}`, "source.txt");
  }
});

test("R01 source archives do not manufacture provenance from CI environment strings", async t => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = captureBuildProvenance(root, { WORKERS_CI_COMMIT_SHA: "a".repeat(40), WORKERS_CI_BRANCH: "main" });
  assert.equal(result.state, "unavailable"); assert.equal(result.commit, null); assert.equal(result.branch, null);
});

test("R01 generation is deterministic, ignored, and clears stale identity before strict refusal", async t => {
  const f = await fixture(t);
  const target = join(f.root, "apps/worker/src/generated-provenance.ts");
  await writeBuildProvenance(f.root, {}, { strict: true });
  const before = await readFile(target, "utf8"), time = (await stat(target)).mtimeMs;
  await writeBuildProvenance(f.root, {}, { strict: true });
  assert.equal(await readFile(target, "utf8"), before); assert.equal((await stat(target)).mtimeMs, time);
  assert.equal(git(f.root, "status", "--porcelain"), "");
  await writeFile(join(f.root, "source.txt"), "changed\n");
  await assert.rejects(writeBuildProvenance(f.root, {}, { strict: true }), /provenance_unavailable/);
  const after = await readFile(target, "utf8");
  assert.ok(after.includes('"state":"dirty"')); assert.ok(!after.includes(f.commit));
});

test("R01 build reports never contain local paths, author details or arbitrary environment values", async t => {
  const f = await fixture(t);
  const result = captureBuildProvenance(f.root, { WORKERS_CI_BRANCH: "secret/branch", WORKERS_CI_COMMIT_SHA: "private-token", CLOUDFLARE_API_TOKEN: "do-not-publish" });
  const text = JSON.stringify(result);
  for (const secret of [f.root, "git@", "private-token", "do-not-publish", "secret/branch"]) assert.ok(!text.includes(secret));
});

test("R01 source observation does not write the Git index or execute fsmonitor", async t => {
  const f = await fixture(t);
  git(f.root, "config", "core.fsmonitor", "definitely-not-an-executable-runmesh-fixture");
  const index = join(f.root, ".git/index"), before = await readFile(index), time = (await stat(index)).mtimeMs;
  assert.equal(captureBuildProvenance(f.root, {}).state, "clean");
  assert.deepEqual(await readFile(index), before); assert.equal((await stat(index)).mtimeMs, time);
});


test("source root identity accepts actual directory aliases, not different directories with similar names", async t => {
  const f = await fixture(t);
  const sibling = await mkdtemp(join(tmpdir(), "runmesh-provenance-other-"));
  t.after(() => rm(sibling, { recursive: true, force: true }));
  const identity = sourceDirectoryIdentity(f.root);
  assert.ok(sameDirectoryIdentity(identity, sourceDirectoryIdentity(resolve(f.root, "."))));
  assert.equal(sameDirectoryIdentity(identity, sourceDirectoryIdentity(sibling)), false);
  assert.equal(sourceDirectoryIdentity(join(f.root, "source.txt")), undefined);
  assert.equal(sourceDirectoryIdentity(join(f.root, "missing-directory")), undefined);
  if (process.platform === "win32") {
    assert.ok(sameDirectoryIdentity(identity, sourceDirectoryIdentity(f.root.replaceAll("\\", "/"))));
    const fromGit = git(f.root, "rev-parse", "--show-toplevel");
    assert.ok(sameDirectoryIdentity(identity, sourceDirectoryIdentity(fromGit)));
    assert.equal(captureBuildProvenance(f.root, {}).state, "clean");
  }
});

test("source root identity rejects absent/zero IDs and distinct 64-bit identities", () => {
  const a = { device: 1n, inode: 9007199254740992n };
  assert.ok(sameDirectoryIdentity(a, { ...a }));
  for (const value of [undefined, null, { device: 2n, inode: a.inode }, { device: 1n, inode: a.inode + 1n }, { device: 1n, inode: 0n }, { device: 1, inode: Number(a.inode) }]) {
    assert.equal(sameDirectoryIdentity(a, value), false);
  }
  assert.equal(sameDirectoryIdentity(undefined, undefined), false);
  assert.equal(sameDirectoryIdentity({ device: 0n, inode: 0n }, { device: 0n, inode: 0n }), false);
});

test("nested source directories cannot claim the enclosing repository identity", async t => {
  const f = await fixture(t);
  assert.equal(captureBuildProvenance(join(f.root, "apps"), {}).state, "unavailable");
});
