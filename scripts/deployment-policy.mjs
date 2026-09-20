import assert from "node:assert/strict";

/** Source-branch checks for the explicitly selected Workers Builds command.
 * This does not claim to secure a direct Cloudflare API call or bare Wrangler.
 */
export function deploymentPlan(environment, env, localBranch) {
  assert.ok(environment === "production" || environment === "development", "Select production or development explicitly");
  assert.ok(!env.CI_COMMIT_TAG && (!env.GITHUB_REF || env.GITHUB_REF.startsWith("refs/heads/")), "Tag and PR refs cannot deploy");
  assert.ok(!env.CI_MERGE_REQUEST_IID && !["pull_request", "pull_request_target"].includes(env.GITHUB_EVENT_NAME), "PR/MR builds cannot deploy");
  const declared = [env.WORKERS_CI_BRANCH, env.CI_COMMIT_BRANCH,
    env.GITHUB_REF?.startsWith("refs/heads/") ? env.GITHUB_REF.slice(11) : undefined].filter(Boolean);
  assert.ok(new Set(declared).size <= 1, "Conflicting source branches");
  const branch = declared[0] ?? localBranch;
  const required = environment === "production" ? "main" : "dev";
  assert.equal(branch, required, `${environment} requires ${required}; refusing to deploy the wrong branch`);
  if (localBranch) assert.equal(localBranch, branch, "Checkout branch differs from the declared source");
  return { environment, branch, worker: environment === "production" ? "runmesh" : "runmeshdev" };
}

export function assertReleased(state, version) {
  assert.equal(state?.state, "released", "Candidate not activated; preserve the current production deployment");
  assert.equal(state.version, version, "Release identity differs from source version");
  assert.match(state.release_commit ?? "", /^[a-f0-9]{40}$/);
  assert.match(state.manifest_sha256 ?? "", /^[a-f0-9]{64}$/);
  // Existing immutable v0.1.2 retains its original dev provenance. Promotion
  // of the serving Worker to main must not rewrite that published history.
}

/** A candidate build can complete while preserving the active production
 * Worker. Provider metadata selects this no-upload behavior, not permission
 * to deploy; uploads still require the independently reviewed release record.
 */
export function productionReleaseDecision(state, version, environment, source) {
  if (state?.state !== "candidate" || environment.WORKERS_CI !== "1") {
    assertReleased(state, version);
    return { action: "deploy" };
  }
  assert.match(version, /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u);
  assert.equal(state.version, version, "Candidate identity differs from source version");
  assert.equal(state.release_branch, "main");
  assert.ok(state.release_commit === undefined || state.release_commit === null, "Candidate cannot reuse prior publication evidence");
  assert.ok(state.manifest_sha256 === undefined || state.manifest_sha256 === null, "Candidate cannot reuse prior publication evidence");
  assert.equal(source?.state, "clean");
  assert.equal(source.branch, "main");
  assert.match(source.commit, /^[a-f0-9]{40}$/u);
  assert.equal(environment.WORKERS_CI_BRANCH, "main");
  assert.equal(environment.WORKERS_CI_COMMIT_SHA, source.commit);
  // Workers Builds documents these four injected variables together:
  // https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
  assert.match(environment.WORKERS_CI_BUILD_UUID ?? "", /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
  return { action: "production_preserved", uploaded: false, reason: "awaiting_verified_release" };
}

/** Resolve the provider override explicitly rather than silently publishing to
 * a different connected Worker. This validates names, not account ownership. */
export function assertDeploymentTarget(plan, configuration, environment = {}) {
  assert.ok(plan && ["production", "development"].includes(plan.environment), "invalid deployment environment");
  const expected = plan.environment === "production" ? "runmesh" : "runmeshdev";
  assert.equal(plan.worker, expected, "deployment plan target differs");
  assert.equal(configuration?.env?.[plan.environment]?.name, expected, "Wrangler target differs from deployment plan");
  if (plan.environment === "production") assert.equal(configuration.name, expected, "top-level production target differs");
  if (environment.WRANGLER_CI_OVERRIDE_NAME !== undefined) assert.equal(environment.WRANGLER_CI_OVERRIDE_NAME, expected, "Workers Builds targets a different Worker");
  return expected;
}
