import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GITLAB_DEV_REMOTE = "gitlab";
const SHA = /^[a-f0-9]{40}$/u;

export function verifiedDev(checks) {
  if (!checks || !Array.isArray(checks.check_runs)) return false;
  return checks.check_runs.some(check => check?.name === "verify-all" && check?.status === "completed" && check?.conclusion === "success" && check?.app?.slug === "github-actions");
}

export function decideDevSync({ githubDevSha, gitlabDevSha, verified, gitlabIsAncestor }) {
  assert.match(githubDevSha ?? "", SHA, "invalid GitHub dev identity");
  assert.match(gitlabDevSha ?? "", SHA, "invalid GitLab dev identity");
  if (githubDevSha === gitlabDevSha) return { state: "already_current", github_dev_sha: githubDevSha, gitlab_dev_sha: gitlabDevSha };
  if (!verified) return { state: "waiting_for_ci", github_dev_sha: githubDevSha, gitlab_dev_sha: gitlabDevSha };
  assert.equal(gitlabIsAncestor, true, "GitLab dev has diverged; refusing non-fast-forward synchronization");
  return { state: "push", github_dev_sha: githubDevSha, gitlab_dev_sha: gitlabDevSha };
}

function command(file, args, cwd, accepted = [0]) {
  const result = spawnSync(file, args, { cwd, env: process.env, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  if (result.error || !accepted.includes(result.status ?? -1)) throw new Error("dev_sync_command_failed");
  return { status: result.status ?? -1, stdout: result.stdout.trim() };
}

export function syncVerifiedDev(root = fileURLToPath(new URL("../", import.meta.url))) {
  command("git", ["fetch", "--no-tags", "origin", "+refs/heads/dev:refs/remotes/origin/dev"], root);
  command("git", ["fetch", "--no-tags", GITLAB_DEV_REMOTE, "+refs/heads/dev:refs/remotes/gitlab/dev"], root);
  const githubDevSha = command("git", ["rev-parse", "refs/remotes/origin/dev"], root).stdout;
  const gitlabDevSha = command("git", ["rev-parse", "refs/remotes/gitlab/dev"], root).stdout;
  assert.match(githubDevSha, SHA); assert.match(gitlabDevSha, SHA);
  if (githubDevSha === gitlabDevSha) {
    const report = decideDevSync({ githubDevSha, gitlabDevSha, verified: true, gitlabIsAncestor: true });
    console.log(JSON.stringify(report)); return report;
  }
  const checks = JSON.parse(command("gh", ["api", `repos/aloneio/runmesh/commits/${githubDevSha}/check-runs?per_page=100`], root).stdout);
  const ancestry = command("git", ["merge-base", "--is-ancestor", gitlabDevSha, githubDevSha], root, [0, 1]);
  const plan = decideDevSync({ githubDevSha, gitlabDevSha, verified: verifiedDev(checks), gitlabIsAncestor: ancestry.status === 0 });
  if (plan.state !== "push") { console.log(JSON.stringify(plan)); return plan; }
  command("git", ["push", GITLAB_DEV_REMOTE, `${githubDevSha}:refs/heads/dev`], root);
  const remote = command("git", ["ls-remote", GITLAB_DEV_REMOTE, "refs/heads/dev"], root).stdout.split(/\s+/u)[0] ?? "";
  assert.equal(remote, githubDevSha, "GitLab dev did not settle on the verified source commit");
  const report = { ...plan, state: "synced" };
  console.log(JSON.stringify(report)); return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assert.equal(process.argv.length, 2); syncVerifiedDev(); }
  catch { console.error("gitlab_dev_sync_failed: preserve GitLab dev and inspect branch/authentication state; no force push was attempted"); process.exitCode = 1; }
}
