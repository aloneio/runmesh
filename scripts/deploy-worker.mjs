import { writeBuildProvenance } from "./build-provenance.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deploymentPlan, assertReleased, assertDeploymentTarget } from "./deployment-policy.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) => execFileSync("git", args, {cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
let prepared;
try {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 && args[0] === "--env", "Use deploy:worker -- --env production|development");
  let local; try { local = git("symbolic-ref", "--quiet", "--short", "HEAD"); } catch { /* Workers Builds may use a detached commit. */ }
  const plan = deploymentPlan(args[1], process.env, local);
  assertDeploymentTarget(plan, JSON.parse(readFileSync(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8")), process.env);
  const sha = git("rev-parse", "HEAD");
  assert.match(sha, /^[a-f0-9]{40}$/);
  const build = await writeBuildProvenance(root, process.env, { strict: true });
  assert.equal(build.commit, sha, "Source moved during deployment preflight");
  assert.equal(build.branch, plan.branch, "Build and requested deployment branch differ");
  if (plan.environment === "production") assertReleased(
    JSON.parse(readFileSync(new URL("../release/release-state.json",import.meta.url),"utf8")),
    JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).version);
  prepared = { plan, sha, build };
} catch {
  // Assertion errors can include raw branch values and host paths. Never
  // emit them from a deployment preflight that has not contacted Cloudflare.
  console.error("deployment_preflight_failed: verify environment, clean source, Git/CI metadata and reviewed release; nothing was uploaded");
  process.exitCode = 1;
}
if (prepared !== undefined) {
  const { plan, sha, build } = prepared;
  console.log(JSON.stringify({deployment:plan,source_commit:sha,source_tree:build.tree}));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js",import.meta.url)),
    "deploy","--config","apps/worker/wrangler.jsonc","--env",plan.environment,"--name",plan.worker,
    "--tag",`${plan.branch}:${sha}`],{cwd:root,env:process.env,stdio:"inherit"});
  if (result.error) console.error("deployment_upload_unavailable: inspect the provider outcome before retrying; no automatic retry was performed");
  process.exitCode = result.status ?? 1;
}
