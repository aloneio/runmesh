import assert from "node:assert/strict";
import { validateStableReleaseProof } from "./baseline-policy.mjs";

export const DEV_RELEASE_INTERVAL = 5;
export const DEV_RELEASE_REPOSITORY = "aloneio/runmesh";
const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u;
const sha = /^[a-f0-9]{40}$/u;
const keys = ["schema_version", "channel", "repository", "source_sha", "source_tree", "stable_sha", "stable_version", "version", "tag", "push_number", "run_id", "published_at"].sort();

/** This dedicated workflow has only dev push triggers. Its run_number counts
 * pushes, not commits; run_attempt deliberately never enters this calculation. */
export function releaseCadence(pushNumber) {
  assert.ok(Number.isSafeInteger(pushNumber) && pushNumber > 0, "invalid push number");
  return { due: pushNumber % DEV_RELEASE_INTERVAL === 0, push_number: pushNumber,
    remaining: (DEV_RELEASE_INTERVAL - pushNumber % DEV_RELEASE_INTERVAL) % DEV_RELEASE_INTERVAL,
    sequence: Math.floor(pushNumber / DEV_RELEASE_INTERVAL) - 1 };
}

export function nextDevVersion(stableVersion, pushNumber) {
  const parsed = typeof stableVersion === "string" && stable.exec(stableVersion);
  assert.ok(parsed, "main must declare a stable version");
  const cadence = releaseCadence(pushNumber); assert.equal(cadence.due, true);
  const patch = Number(parsed[3]) + 1; assert.ok(patch <= 999999999);
  return `${parsed[1]}.${parsed[2]}.${patch}-dev.${cadence.sequence}`;
}

export function validateDevPlan(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.ok(value.schema_version === 1 || value.schema_version === 2, "unsupported development plan schema");
  assert.deepEqual(Object.keys(value).sort(), value.schema_version === 2 ? [...keys, "stable_release"].sort() : keys, "unexpected development plan fields");
  if (value.schema_version === 2) validateStableReleaseProof(value.stable_release);
  assert.equal(value.channel, "dev");
  assert.equal(value.repository, DEV_RELEASE_REPOSITORY);
  for (const key of ["source_sha", "source_tree", "stable_sha"]) assert.match(value[key], sha);
  assert.ok(Number.isSafeInteger(value.run_id) && value.run_id > 0);
  assert.equal(value.version, nextDevVersion(value.stable_version, value.push_number));
  assert.equal(value.tag, `v${value.version}`);
  assert.match(value.published_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  assert.equal(new Date(value.published_at).toISOString().replace(".000Z", "Z"), value.published_at);
  return Object.freeze({ ...value, ...(value.schema_version === 2 ? { stable_release: validateStableReleaseProof(value.stable_release) } : {}) });
}

export function createDevPlan(input) {
  const version = nextDevVersion(input.stable_version, input.push_number);
  assert.equal(input.schema_version, undefined, "plan schema is owned by the constructor");
  return validateDevPlan({ schema_version: 2, channel: "dev", repository: DEV_RELEASE_REPOSITORY, ...input, version, tag: `v${version}` });
}

export function assertPlanContext(plan, env) {
  validateDevPlan(plan);
  assert.equal(env.GITHUB_REPOSITORY, DEV_RELEASE_REPOSITORY);
  assert.equal(env.GITHUB_REF, "refs/heads/dev"); assert.equal(env.GITHUB_EVENT_NAME, "push");
  assert.equal(env.GITHUB_SHA, plan.source_sha);
  assert.equal(Number(env.GITHUB_RUN_ID), plan.run_id);
  assert.equal(Number(env.GITHUB_RUN_NUMBER), plan.push_number);
}
