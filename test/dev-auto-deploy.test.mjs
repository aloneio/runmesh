import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decideDevSync, GITLAB_DEV_REMOTE, verifiedDev } from "../scripts/sync-gitlab-dev.mjs";

const A = "a".repeat(40), B = "b".repeat(40);
test("dev bridge waits for the mandatory aggregate and is fast-forward only", () => {
  assert.equal(decideDevSync({ githubDevSha: B, gitlabDevSha: B, verified: false, gitlabIsAncestor: true }).state, "already_current");
  assert.equal(decideDevSync({ githubDevSha: B, gitlabDevSha: A, verified: false, gitlabIsAncestor: true }).state, "waiting_for_ci");
  assert.equal(decideDevSync({ githubDevSha: B, gitlabDevSha: A, verified: true, gitlabIsAncestor: true }).state, "push");
  assert.throws(() => decideDevSync({ githubDevSha: B, gitlabDevSha: A, verified: true, gitlabIsAncestor: false }), /diverged/);
});
test("only a completed successful GitHub Actions verify-all check satisfies the gate", () => {
  const check = (name, status, conclusion, slug = "github-actions") => ({ name, status, conclusion, app: { slug } });
  assert.equal(verifiedDev({ check_runs: [check("verify-all", "completed", "success")] }), true);
  for (const runs of [[], [check("verify", "completed", "success")], [check("verify-all", "in_progress", null)], [check("verify-all", "completed", "failure")], [check("verify-all", "completed", "success", "other")]]) assert.equal(verifiedDev({ check_runs: runs }), false);
  assert.equal(verifiedDev(undefined), false); assert.equal(GITLAB_DEV_REMOTE, "gitlab");
});
test("mirrored dev pushes trigger deployment without duplicating GitLab SaaS verification", async () => {
  const gitlab = await readFile(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");
  assert.ok(gitlab.includes('$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"'));
  assert.ok(!gitlab.includes('$CI_PIPELINE_SOURCE == "push" && ($CI_COMMIT_BRANCH == "main" || $CI_COMMIT_BRANCH == "dev")'));
  assert.ok(!gitlab.includes('$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "dev"'));
});
test("repository CI needs no cross-provider credential and the host bridge is unprivileged and periodic", async () => {
  const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(!ci.includes("GITLAB_DEV_SYNC_TOKEN")); assert.ok(!ci.includes("sync-gitlab-dev"));
  const service = await readFile(new URL("../ops/systemd/runmesh-dev-sync.service", import.meta.url), "utf8");
  const timer = await readFile(new URL("../ops/systemd/runmesh-dev-sync.timer", import.meta.url), "utf8");
  assert.match(service, /^User=xwzy$/mu); assert.match(service, /^NoNewPrivileges=true$/mu);
  assert.match(service, /^ExecStart=\/usr\/bin\/env node \/home\/xwzy\/runmesh\/scripts\/sync-gitlab-dev\.mjs$/mu);
  assert.match(timer, /^OnUnitActiveSec=1min$/mu); assert.match(timer, /^Persistent=true$/mu);
});
