import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isGitHubMergeCommit, validateCommit, selectPrivacyRevision } from "../scripts/check-git-privacy.mjs";

const knownGood = { name: "aloneio", email: "git@aloneio.aleeas.com", committerName: "aloneio",
  committerEmail: "git@aloneio.aleeas.com", message: "fix(security): reject unsafe commit metadata" };
test("commit validation enforces exact identity, ASCII messages and no assistant attribution", () => {
  assert.deepEqual(validateCommit(knownGood), []);
  assert.deepEqual(validateCommit({ ...knownGood, email: "private@example.invalid" }), ["author"]);
  assert.deepEqual(validateCommit({ ...knownGood, committerName: "Somebody" }), ["committer"]);
  assert.deepEqual(validateCommit({ ...knownGood, message: "fix: 调整" }), ["message_format"]);
  assert.deepEqual(validateCommit({ ...knownGood, message: "fix: Codex output" }), ["assistant_attribution"]);
  assert.deepEqual(validateCommit({ ...knownGood, message: "fix: issue\n\nCo-authored-by: Other <other@example.invalid>" }), ["attribution_trailer"]);
  assert.deepEqual(validateCommit({ ...knownGood, message: "" }), ["message_format"]);
  const githubMerge = { ...knownGood, email: "merge-author@example.invalid", committerName: "GitHub",
    committerEmail: "noreply@github.com", parentCount: 2, message: "Harden release provenance and SBOM verification" };
  assert.equal(isGitHubMergeCommit(githubMerge), true);\n  assert.equal(isGitHubMergeCommit({ ...githubMerge, message: "custom protected merge title" }), true);
  assert.deepEqual(validateCommit(githubMerge), []);
  assert.equal(isGitHubMergeCommit({ ...githubMerge, parentCount: 1 }), false);
  assert.deepEqual(validateCommit({ ...githubMerge, parentCount: 1 }), ["author", "committer"]);
});
test("CI ranges only accept an observed ancestor; otherwise scan complete reachable history", () => {
  const old = "a".repeat(40);
  assert.equal(selectPrivacyRevision({}, () => false), "HEAD");
  assert.equal(selectPrivacyRevision({ CI: "true", CI_COMMIT_BEFORE_SHA: old }, x => x === old), old + "..HEAD");
  assert.equal(selectPrivacyRevision({ CI: "true", CI_COMMIT_BEFORE_SHA: old }, () => false), "HEAD");
  assert.equal(selectPrivacyRevision({ CI: "true", CI_PIPELINE_SOURCE: "merge_request_event",
    CI_MERGE_REQUEST_DIFF_BASE_SHA: old }, () => true), old + "..HEAD");
  assert.equal(selectPrivacyRevision({ CI: "true", CI_COMMIT_BEFORE_SHA: "0".repeat(40) }, () => true), "HEAD");
});
test("privacy command examines actual commit objects, not the configured git identity", async t => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-git-privacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  function cmd(args, env = {}) {
    return spawnSync(args[0], args.slice(1), { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, timeout: 10000 });
  }
  const git = (...args) => cmd(["git", ...args]);
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("config", "user.name", "aloneio").status, 0);
  assert.equal(git("config", "user.email", "git@aloneio.aleeas.com").status, 0);
  assert.equal(git("commit", "--allow-empty", "-qm", "fix: setup").status, 0);
  const base = git("rev-parse", "HEAD").stdout.trim();
  assert.equal(git("commit", "--allow-empty", "-qm", "fix: clean").status, 0);
  const script = new URL("../scripts/check-git-privacy.mjs", import.meta.url).pathname;
  assert.equal(cmd([process.execPath, script, "--all"]).status, 0);
  assert.equal(git("commit", "--allow-empty", "-qm", "feat: Codex event").status, 0);
  assert.notEqual(cmd([process.execPath, script, "--all"]).status, 0);
  assert.match(cmd([process.execPath, script, "--all"]).stderr, /assistant_attribution/u);
  const head = git("rev-parse", "HEAD").stdout.trim();
  assert.equal(git("reset", "--hard", "-q", base).status, 0);
  assert.equal(git("commit", "--allow-empty", "-qm", "fix: provenance").status, 0);
  assert.equal(cmd([process.execPath, script, "--ci"], { CI: "true", CI_COMMIT_BEFORE_SHA: base }).status, 0);
  assert.equal(cmd([process.execPath, script, "--ci"], { CI: "true", CI_COMMIT_BEFORE_SHA: head }).status, 0);
});
