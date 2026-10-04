import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { releaseCadence, createDevPlan, assertPlanContext, assertDeferralContext, validateDevDeferral, DEV_RELEASE_REPOSITORY } from "./policy.mjs";
import { assertSource, git, mainModule, readPlan, root } from "./io.mjs";
import { readEvidenceJson } from "../evidence-io.mjs";
import { observeStableBaseline } from "./baseline.mjs";

/** Persist one decision before any build/signing job. Retries replay it. */
export async function prepareDevelopmentPlan(env, ports = {}) {
  const directory = ports.directory ?? join(root, ".dev-release");
  const readGit = ports.git ?? git, observe = ports.observeStableBaseline ?? observeStableBaseline;
  const verifySource = ports.assertSource ?? assertSource;
  await mkdir(directory, { recursive: true });
  const existing = (await readdir(directory)).filter(name => ["plan.json", "deferred.json"].includes(name));
  let plan, deferred;
  if (Number(env.GITHUB_RUN_ATTEMPT) > 1) {
    assert.equal(existing.length, 1, "retry requires exactly one frozen planning outcome");
    if (existing[0] === "plan.json") plan = await readPlan(join(directory, "plan.json"));
    else deferred = validateDevDeferral(await readEvidenceJson(join(directory, "deferred.json"), 4096));
  } else {
    assert.equal(Number(env.GITHUB_RUN_ATTEMPT), 1); assert.equal(existing.length, 0, "planning outcome already exists");
    let baseline;
    try { baseline = await observe(env.GITHUB_SHA); }
    catch (error) {
      if (error?.code !== "stable_baseline_unpublished") throw error;
      deferred = validateDevDeferral({ schema_version: 1, state: "deferred", reason: "stable_baseline_unpublished",
        repository: DEV_RELEASE_REPOSITORY, ref: "refs/heads/dev", source_sha: env.GITHUB_SHA, source_tree: await readGit("rev-parse", "HEAD^{tree}"),
        push_number: Number(env.GITHUB_RUN_NUMBER), run_id: Number(env.GITHUB_RUN_ID) });
    }
    if (deferred === undefined) {
      const publishedAt = new Date(Number(await readGit("show", "-s", "--format=%ct", env.GITHUB_SHA)) * 1000).toISOString().replace(".000Z", "Z");
      plan = createDevPlan({ source_sha: env.GITHUB_SHA, source_tree: await readGit("rev-parse", "HEAD^{tree}"),
        ...baseline, push_number: Number(env.GITHUB_RUN_NUMBER), run_id: Number(env.GITHUB_RUN_ID), published_at: publishedAt });
    }
  }
  if (deferred !== undefined) assertDeferralContext(deferred, env); else assertPlanContext(plan, env);
  const outcome = deferred ?? plan;
  await verifySource(outcome);
  if (Number(env.GITHUB_RUN_ATTEMPT) === 1) {
    await writeFile(join(directory, deferred === undefined ? "plan.json" : "deferred.json"), JSON.stringify(outcome, null, 2) + "\n", { flag: "wx" });
  }
  return deferred === undefined ? { ready: true, plan } : { ready: false, deferred };
}

async function main() {
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
    return;
  }
  assert.equal(process.argv.length, 2); assert.equal(cadence.due, true);
  const result = await prepareDevelopmentPlan(env);
  if (!result.ready) {
    await appendFile(env.GITHUB_OUTPUT, "ready=false\nreason=stable_baseline_unpublished\n");
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `Dev push #${cadence.push_number} is **deferred** while main completes stable publication. This run keeps its recorded decision on retry; the next due push can plan a new batch. Independent CI continues to verify this source.\n`);
    console.log(JSON.stringify(result.deferred));
    return;
  }
  const { plan } = result;
  await appendFile(env.GITHUB_OUTPUT, `ready=true\nversion=${plan.version}\ntag=${plan.tag}\n`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `Planned **${plan.tag}** from dev \`${plan.source_sha}\`; main baseline \`${plan.stable_version}\` at \`${plan.stable_sha}\`. This plan is reused unchanged on retries.\n`);
  console.log(JSON.stringify(plan));
}

if (mainModule(import.meta.url)) await main();
