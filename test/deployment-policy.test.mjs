import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deploymentPlan, assertReleased, assertDeploymentTarget } from "../scripts/deployment-policy.mjs";
import { reviewedReleaseSource } from "../scripts/runtime-config-tools.mjs";

test("production accepts only main and development only dev",()=>{
  assert.equal(deploymentPlan("production",{WORKERS_CI_BRANCH:"main"}).worker,"runmesh");
  assert.equal(deploymentPlan("development",{WORKERS_CI_BRANCH:"dev"}).worker,"runmeshdev");
  for(const [env,branch] of [["production","dev"],["production","feature/x"],["development","main"],["production",undefined],["unknown","main"]]) assert.throws(()=>deploymentPlan(env,{},branch));
});
test("deployment rejects PRs, tags, conflicting metadata and a mismatched checkout",()=>{
  for(const env of [{CI_COMMIT_TAG:"v0.1.2"},{GITHUB_REF:"refs/tags/v0.1.2"},{GITHUB_REF:"refs/pull/1/merge"},{CI_COMMIT_BRANCH:"dev",WORKERS_CI_BRANCH:"main"},{CI_MERGE_REQUEST_IID:"1",CI_COMMIT_BRANCH:"main"},{GITHUB_EVENT_NAME:"pull_request",GITHUB_REF:"refs/heads/main"}]) assert.throws(()=>deploymentPlan("production",env,"main"));
  assert.throws(()=>deploymentPlan("production",{WORKERS_CI_BRANCH:"main"},"dev"));
  assert.equal(deploymentPlan("production",{GITHUB_REF:"refs/heads/main"}).branch,"main");
});
test("unactivated versions cannot displace the current installer and legacy provenance stays intact",()=>{
  const state={version:"0.1.2",state:"released",release_commit:"a".repeat(40),manifest_sha256:"b".repeat(64)};
  assert.doesNotThrow(()=>assertReleased(state,"0.1.2"));
  for(const v of [{...state,state:"candidate"},{...state,version:"0.1.3"},{...state,release_commit:""},{...state,manifest_sha256:""}]) assert.throws(()=>assertReleased(v,"0.1.2"));
});
test("formal publication rejects dev before verification and uses a main target",async()=>{
  const workflow=await readFile(new URL("../.github/workflows/release.yml",import.meta.url),"utf8");
  assert.ok(workflow.includes("main-only release source") && workflow.includes("needs: [source]"));
  assert.ok(workflow.includes("--target main"));
  assert.ok(!workflow.includes("refs/heads/dev") && !workflow.includes("origin/dev"));
});
test("cutover preserves the current production namespace, storage and fixed release gate",async()=>{
  const c=JSON.parse(await readFile(new URL("../apps/worker/wrangler.jsonc",import.meta.url),"utf8"));
  const p=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8"));
  assert.equal(c.name,"runmesh");assert.equal(c.env.production.name,"runmesh");
  const state=JSON.parse(await readFile(new URL("../release/release-state.json",import.meta.url),"utf8"));
  assert.equal(await readFile(new URL("../apps/worker/src/generated-release.ts",import.meta.url),"utf8"), reviewedReleaseSource(p.version,state));
  assert.equal(c.env.production.d1_databases[0].database_name,"runmesh-audit-history");
  assert.deepEqual(c.env.production.durable_objects.bindings.map(x=>x.class_name),["RegistryDOv2","RunnerDOv2"]);
  assert.notEqual(c.env.development.name,c.name);
});

test("deployment targets, configured environments and provider overrides must agree", async () => {
  const config = JSON.parse(await readFile(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8"));
  for (const [environment, branch, worker] of [["development", "dev", "runmeshdev"], ["production", "main", "runmesh"]]) {
    const plan = deploymentPlan(environment, {}, branch);
    assert.equal(assertDeploymentTarget(plan, config, { WRANGLER_CI_OVERRIDE_NAME: worker }), worker);
    for (const wrong of ["", "other", environment === "development" ? "runmesh" : "runmeshdev"])
      assert.throws(() => assertDeploymentTarget(plan, config, { WRANGLER_CI_OVERRIDE_NAME: wrong }));
    const drifted = structuredClone(config); drifted.env[environment].name = "other";
    assert.throws(() => assertDeploymentTarget(plan, drifted));
  }
});
