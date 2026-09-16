import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseCadence, createDevPlan, assertPlanContext, DEV_RELEASE_REPOSITORY } from "./policy.mjs";
import { assertSource, git, readPlan, root } from "./io.mjs";

const env = process.env;
assert.equal(env.GITHUB_REPOSITORY, DEV_RELEASE_REPOSITORY);
assert.equal(env.GITHUB_REF, "refs/heads/dev"); assert.equal(env.GITHUB_EVENT_NAME, "push");
const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
assert.equal(event.deleted, false); assert.equal(event.after, env.GITHUB_SHA);
assert.equal(event.repository?.full_name, DEV_RELEASE_REPOSITORY);
assert.equal(event.ref, "refs/heads/dev");
const cadence = releaseCadence(Number(env.GITHUB_RUN_NUMBER));
assert.ok(env.GITHUB_OUTPUT);
if (process.argv[2] === "cadence" && process.argv.length === 3) {
  await appendFile(env.GITHUB_OUTPUT, `due=${cadence.due}\n`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `Dev push #${cadence.push_number}: ${cadence.due ? "prerelease verification is due" : `${cadence.remaining} more push(es) until verification`}. Reruns do not increment this counter.\n`);
  console.log(JSON.stringify(cadence));
} else {
  assert.equal(process.argv.length, 2); assert.equal(cadence.due, true);
  const directory = join(root, ".dev-release"); await mkdir(directory, { recursive: true });
  const filename = join(directory, "plan.json");
  let plan;
  if (Number(env.GITHUB_RUN_ATTEMPT) > 1) {
    // The workflow downloads this run's immutable plan artifact before calling
    // us. Missing/expired evidence fails closed, never silently picks a new tag.
    plan = await readPlan(filename);
  } else {
    assert.equal(Number(env.GITHUB_RUN_ATTEMPT), 1);
    await git("fetch", "--no-tags", "origin", "main:refs/remotes/origin/main");
    const stableSha = await git("rev-parse", "origin/main");
    const stablePackage = JSON.parse(await git("show", `${stableSha}:package.json`));
    const publishedAt = new Date(Number(await git("show", "-s", "--format=%ct", env.GITHUB_SHA)) * 1000).toISOString().replace(".000Z", "Z");
    plan = createDevPlan({ source_sha: env.GITHUB_SHA, source_tree: await git("rev-parse", "HEAD^{tree}"),
      stable_sha: stableSha, stable_version: stablePackage.version, push_number: cadence.push_number,
      run_id: Number(env.GITHUB_RUN_ID), published_at: publishedAt });
    await assertSource(plan);
    await writeFile(filename, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
  }
  assertPlanContext(plan, env); await assertSource(plan);
  await appendFile(env.GITHUB_OUTPUT, `version=${plan.version}\ntag=${plan.tag}\n`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `Planned **${plan.tag}** from dev \`${plan.source_sha}\`; main baseline \`${plan.stable_version}\` at \`${plan.stable_sha}\`. This plan is reused unchanged on retries.\n`);
  console.log(JSON.stringify(plan));
}
