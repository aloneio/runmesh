import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXPECTED_NAME = "aloneio";
const EXPECTED_EMAIL = "git@aloneio.aleeas.com";
const SHA = /^[a-f0-9]{40}$/u;
const GENERATOR = /\b(?:codex|chatgpt|claude|copilot|anthropic|gpt[- ]?[0-9]+)\b/iu;
const CO_AUTHOR = /^\s*(?:co-authored-by|generated-by|assisted-by)\s*:/imu;
const GITHUB_MERGE_MESSAGE = /^Merge(?:\s|$)/u;

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, "git_privacy_git_unavailable");
  return result.stdout;
}

export function isGitHubMergeCommit({ committerName, committerEmail, parentCount, message }) {
  return committerName === "GitHub"
    && committerEmail === "noreply@github.com"
    && Number.isInteger(parentCount)
    && parentCount >= 2
    && GITHUB_MERGE_MESSAGE.test(message.trim());
}

export function validateCommit({ name, email, committerName, committerEmail, parentCount, message }) {
  const issues = [];
  // GitHub creates the merge commit on a protected main branch. Its
  // platform identity is transport metadata; user-created commits remain
  // subject to the exact repository identity policy below.
  const githubMerge = isGitHubMergeCommit({ committerName, committerEmail, parentCount, message });
  if (!githubMerge && (name !== EXPECTED_NAME || email !== EXPECTED_EMAIL)) issues.push("author");
  if (!githubMerge && (committerName !== EXPECTED_NAME || committerEmail !== EXPECTED_EMAIL)) issues.push("committer");
  if (!message.trim() || !/^[\x00-\x7f]*$/u.test(message)) issues.push("message_format");
  if (CO_AUTHOR.test(message)) issues.push("attribution_trailer");
  if (GENERATOR.test(message)) issues.push("assistant_attribution");
  return issues;
}

export function selectPrivacyRevision(environment, isAncestor) {
  if (!environment.CI) return "HEAD";
  const bases = environment.CI_PIPELINE_SOURCE === "merge_request_event"
    ? [environment.CI_MERGE_REQUEST_DIFF_BASE_SHA]
    : [environment.CI_COMMIT_BEFORE_SHA];
  for (const base of bases) {
    if (typeof base === "string" && SHA.test(base) && base !== "0".repeat(40) && isAncestor(base)) {
      return base + "..HEAD";
    }
  }
  // Rewritten histories and initial pipelines may have no comparable previous
  // SHA. Inspect the *whole* reachable branch rather than only the tip.
  return "HEAD";
}

function commitsIn(revision) {
  const output = git(["log", "--no-use-mailmap", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%P%x00%B%x1e", revision]);
  return output.split("\x1e").map(raw => raw.trim()).filter(Boolean).map(raw => {
    const fields = raw.split("\x00");
    assert.ok(fields.length >= 7 && SHA.test(fields[0]), "git_privacy_invalid_commit");
    const parents = fields[5].trim().split(/\s+/u).filter(Boolean);
    return { sha: fields[0], name: fields[1], email: fields[2], committerName: fields[3], committerEmail: fields[4],
      parentCount: parents.length, message: fields.slice(6).join("\x00") };
  });
}

function check() {
  assert.ok(process.argv.length <= 3, "git_privacy_arguments");
  const mode = process.argv[2] ?? "--ci";
  assert.ok(["--ci", "--all", "--head"].includes(mode), "git_privacy_arguments");
  const revision = mode === "--all" ? "--all" : mode === "--head" ? "HEAD^..HEAD"
    : selectPrivacyRevision(process.env, base => spawnSync("git", ["merge-base", "--is-ancestor", base, "HEAD"], { timeout: 10000, stdio: "ignore" }).status === 0);
  const commits = commitsIn(revision);
  assert.ok(commits.length > 0, "git_privacy_no_commits");
  const failures = [];
  for (const commit of commits) {
    const issues = validateCommit(commit);
    if (issues.length) failures.push({ sha: commit.sha.slice(0, 12), issues });
  }
  if (failures.length) {
    // Never print private email addresses, original messages or paths to CI.
    for (const item of failures.slice(0, 12)) console.error("git_privacy_rejected", item.sha, item.issues.join(","));
    console.error("git_privacy: failed (" + failures.length + "/" + commits.length + " commits)");
    process.exitCode = 1;
  } else console.log("git_privacy: passed (" + commits.length + " commits)");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { check(); } catch { console.error("git_privacy: verification unavailable"); process.exitCode = 1; }
}
