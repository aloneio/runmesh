import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deploymentPlan, assertReleased } from "./deployment-policy.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === "--env", "Use deploy:worker -- --env production|development");
const git = (...args) => execFileSync("git", args, {cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
let local; try { local = git("symbolic-ref", "--quiet", "--short", "HEAD"); } catch { /* Workers Builds may use a detached commit. */ }
const plan = deploymentPlan(args[1], process.env, local);
const sha = git("rev-parse", "HEAD");
assert.match(sha, /^[a-f0-9]{40}$/);
assert.equal(git("diff", "HEAD", "--name-only"), "", "Deploy an unchanged tracked checkout");
if (plan.environment === "production") assertReleased(
  JSON.parse(readFileSync(new URL("../release/release-state.json",import.meta.url),"utf8")),
  JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).version);
console.log(JSON.stringify({deployment:plan,source_commit:sha}));
const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js",import.meta.url)),
  "deploy","--config","apps/worker/wrangler.jsonc","--env",plan.environment,
  "--tag",`${plan.branch}:${sha}`],{cwd:root,env:process.env,stdio:"inherit"});
if(result.error) throw result.error;
process.exitCode = result.status ?? 1;
