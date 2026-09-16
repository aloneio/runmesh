import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { readProviderJson, validateGitlabEvidence } from "../crossforge-evidence.mjs";
import { assertPlanContext } from "./policy.mjs";
import { assertSource, mainModule, readPlan } from "./io.mjs";

/** Bounded read-only wait for the exact mirrored source. A failed/skipped job
 * is not accepted, nor is an older green run for a different commit. */
export async function waitForGitlab(plan, get, { attempts = 40, pause = () => setTimeout(30000) } = {}) {
  assert.ok(Number.isSafeInteger(attempts) && attempts > 0 && attempts <= 40);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pipelines = await get(`pipelines?sha=${plan.source_sha}&ref=dev&source=push&order_by=id&sort=desc&per_page=2`);
    assert.ok(Array.isArray(pipelines) && pipelines.length <= 2);
    if (pipelines.length > 0) {
      const id = pipelines[0].id; assert.ok(Number.isSafeInteger(id) && id > 0);
      const pipeline = await get(`pipelines/${id}`);
      assert.equal(pipeline.sha, plan.source_sha); assert.equal(pipeline.ref, "dev"); assert.equal(pipeline.source, "push");
      if (pipeline.status === "success") {
        const jobs = await get(`pipelines/${id}/jobs?include_retried=false&per_page=100`);
        assert.ok(Array.isArray(jobs) && jobs.length < 100, "GitLab job evidence is truncated");
        return validateGitlabEvidence({ sha: plan.source_sha, branch: "dev" }, pipeline, jobs);
      }
      assert.ok(["created", "waiting_for_resource", "preparing", "pending", "running"].includes(pipeline.status), "GitLab verification failed or is not automatic");
    }
    if (attempt + 1 < attempts) await pause();
  }
  throw new Error("Timed out waiting for successful exact-source GitLab verification");
}

if (mainModule(import.meta.url)) {
  assert.equal(process.argv.length, 3);
  const plan = await readPlan(process.argv[2]); assertPlanContext(plan, process.env); await assertSource(plan);
  // This project's GitLab mirror is private. Require a project-scoped read_api
  // secret in dev-release; never fall back to an administrator credential.
  assert.ok(process.env.GITLAB_READ_API_TOKEN, "Configure GITLAB_READ_API_TOKEN (project read_api) in the GitHub dev-release environment before publishing");
  const headers = { "PRIVATE-TOKEN": process.env.GITLAB_READ_API_TOKEN };
  const result = await waitForGitlab(plan, path => readProviderJson(`https://gitlab.com/api/v4/projects/85844627/${path}`, headers));
  console.log(JSON.stringify(result));
}
