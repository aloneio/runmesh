import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import { CI_CHECKS, CHECK_IDS, AGGREGATE_JOBS, NATIVE_COMMANDS, WINDOWS_TRANSPORT_STEP, LTS_COMMANDS, BROWSER_COMMANDS, checkCommand, githubReportUpload, gitlabReportArtifacts, GITLAB_EVENTS } from "./ci-contract.mjs";

export function parseCi(source) {
  assert.ok(typeof source === "string" && Buffer.byteLength(source) <= 1048576, "CI YAML byte budget");
  const doc = parseDocument(source, { uniqueKeys: true, strict: true });
  assert.equal(doc.errors.length, 0, "invalid or duplicate CI YAML keys");
  const value = doc.toJS({ maxAliasCount: 0 });
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "CI must be a mapping");
  return value;
}
const eq = (actual, expected, reason) => assert.deepEqual(actual, expected, reason);
const split = value => typeof value === "string" ? value.split(/\s*&&\s*/u).map(x => x.trim()) : [];
function hardJob(job, label) {
  assert.ok(job && job.if === undefined && job["continue-on-error"] !== true && job.allow_failure !== true, `${label} must be unconditional and blocking`);
  // Dynamic failure expressions are not statically equivalent to false.
  for (const key of ["continue-on-error", "allow_failure"]) assert.ok(job[key] === undefined || job[key] === false, `${label} soft failure forbidden`);
}
function rules(value, label) {
  assert.ok(Array.isArray(value) && value.length === GITLAB_EVENTS.length + 1, `${label} needs explicit supported events`);
  for (const [index, expression] of GITLAB_EVENTS.entries()) eq(value[index], { if: expression }, `${label} event rule changed`);
  eq(value.at(-1), { when: "never" }, `${label} must deny other events`);
}
function requiredStep(steps, command, condition) {
  const matches = steps.filter(step => step.run === command);
  assert.equal(matches.length, 1, `missing/duplicate executable step: ${command}`);
  const step = matches[0];
  assert.equal(step.shell, undefined, "critical steps must use the reviewed default shell");
  assert.equal(step.if, condition, `critical step condition changed: ${command}`);
  assert.ok(step["continue-on-error"] === undefined && step["working-directory"] === undefined, `nonblocking/relocated critical step: ${command}`);
}
function reportUpload(job, name) {
  const uploads = job.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(uploads.length, name === "runner-lts" ? 0 : 1, `${name} must have exactly its reviewed report uploads`);
  if (name === "runner-lts") return;
  const expected = githubReportUpload(name), upload = uploads[0];
  eq(upload.uses, expected.uses, `${name} report upload action changed`);
  eq(upload.if, expected.if, `${name} must preserve reports after failed tests`);
  eq(upload.with, expected.with, `${name} report upload must retain the exact safe scope and identity`);
  assert.ok(job.steps.indexOf(upload) > job.steps.findLastIndex(step => step.run !== undefined), `${name} must upload reports after producing them`);
  for (const key of Object.keys(upload)) assert.ok(["name", "if", "uses", "with"].includes(key), `${name} report upload cannot add execution overrides`);
}

/** Restricted, reviewed YAML grammar, not an interpreter for arbitrary shell
 * or a defense against an administrator rewriting the checker itself. */
export function validateCiWiring(pkg, githubText, gitlabText) {
  const gh = parseCi(githubText), gl = parseCi(gitlabText);
  eq(gh.on?.push?.branches, ["main", "dev"], "main/dev push coverage");
  for (const event of ["pull_request", "workflow_dispatch", "workflow_call"]) assert.ok(Object.hasOwn(gh.on, event), `missing ${event}`);
  eq(gh.permissions, { contents: "read" }, "ordinary CI token must be read-only");
  const verify = gh.jobs?.verify; hardJob(verify, "GitHub verify");
  assert.equal(verify["runs-on"], "ubuntu-latest");
  assert.ok(Number.isSafeInteger(verify["timeout-minutes"]) && verify["timeout-minutes"] <= 30);
  assert.ok(verify.defaults === undefined && gh.defaults === undefined, "implicit working-directory/shell overrides are unreviewed");
  for (const id of CHECK_IDS) requiredStep(verify.steps, checkCommand(id));
  const order = verify.steps.filter(s => typeof s.run === "string" && s.run.startsWith("node scripts/ci-check.mjs ")).map(s => s.run);
  eq(order, CHECK_IDS.map(checkCommand), "mandatory checks reordered, removed, or duplicated");
  for (const name of AGGREGATE_JOBS) {
    hardJob(gh.jobs?.[name], name);
    reportUpload(gh.jobs[name], name);
    assert.equal(gh.jobs[name].defaults, undefined, "critical jobs must not override the reviewed shell or working directory");
    for (const step of gh.jobs[name].steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with?.["persist-credentials"], false, "checkout must not retain credentials");
      if (step.uses) assert.match(step.uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/u, "actions must use full immutable commits");
    }
  }
  eq(gh.jobs["native-runner"].strategy?.matrix, { os: ["ubuntu-latest", "windows-latest", "macos-latest"] }, "native matrix must execute every declared platform");
  assert.equal(gh.jobs["native-runner"]["runs-on"], "${{ matrix.os }}", "native jobs must run on their matrix platform");
  eq(gh.jobs["runner-lts"].strategy?.matrix, { node: ["22.23.2", "24.21.0"] }, "LTS matrix must execute every declared runtime");
  for (const command of NATIVE_COMMANDS) requiredStep(gh.jobs["native-runner"].steps, command);
  requiredStep(gh.jobs["native-runner"].steps, WINDOWS_TRANSPORT_STEP.run, WINDOWS_TRANSPORT_STEP.if);
  for (const command of LTS_COMMANDS) requiredStep(gh.jobs["runner-lts"].steps, command);
  const ltsSteps = gh.jobs["runner-lts"].steps;
  const runtimeSetup = ltsSteps.filter(step => step.uses?.startsWith("actions/setup-node@")).at(-1);
  assert.equal(runtimeSetup?.with?.["node-version"], "${{ matrix.node }}", "LTS tests must use the matrix runtime");
  assert.ok(runtimeSetup.if === undefined && runtimeSetup["continue-on-error"] === undefined, "LTS runtime setup must be unconditional and blocking");
  for (const command of ["npm run test --workspace=@aloneio/runmesh-runner", "node apps/runner/dist/runmesh.cjs --version"]) {
    assert.ok(ltsSteps.indexOf(runtimeSetup) < ltsSteps.findIndex(step => step.run === command), "LTS runtime must be selected before its tests");
  }
  for (const command of BROWSER_COMMANDS) requiredStep(gh.jobs.browser.steps, command);
  eq(gh.jobs.browser.steps.filter(step => step.run !== undefined).map(step => step.run), BROWSER_COMMANDS, "GitHub browser preparation and tests must execute in the reviewed order");
  const aggregate = gh.jobs["verify-all"];
  assert.equal(aggregate?.defaults, undefined, "aggregate must not override the result-check shell or working directory");
  eq(aggregate?.needs, [...AGGREGATE_JOBS], "aggregate must include every required job");
  assert.equal(aggregate.if, "always()", "aggregate must run after failure or skip");
  assert.ok(!aggregate["continue-on-error"] && aggregate.steps?.length === 1);
  const env = Object.fromEntries(AGGREGATE_JOBS.map(name => [name.replaceAll("-", "_").toUpperCase(), `\${{ needs.${name}.result }}`]));
  eq(aggregate.steps[0].env, env, "aggregate must consume actual dependency results");
  assert.equal(aggregate.steps[0].run, Object.keys(env).map(key => `test "$${key}" = success`).join(" && "), "aggregate cannot mask failed dependencies");
  requiredStep(aggregate.steps, aggregate.steps[0].run);
  hardJob(gl.verify, "GitLab verify"); hardJob(gl.browser, "GitLab browser");
  rules(gl.workflow?.rules, "GitLab workflow"); rules(gl.verify.rules, "GitLab verify"); rules(gl.browser.rules, "GitLab browser");
  for (const name of ["verify", "browser"]) {
    assert.ok(gl[name].extends === undefined && gl[name].when === undefined, "unreviewed inherited/manual " + name);
    eq(gl[name].artifacts, gitlabReportArtifacts(), `GitLab ${name} must preserve only the reviewed reports after failure`);
  }
  eq(gl.verify.script, ["npm install --global npm@10.9.3", ...CHECK_IDS.map(checkCommand)], "GitLab must execute all checks without shell masking");
  assert.equal(gl.verify.timeout, "30m");
  eq(gl.browser.script, BROWSER_COMMANDS, "GitLab browser preparation and tests must execute in order without shell masking");
  // Do not accept a shell comment, `|| true`, background process, or test-name
  // filter as equivalent to the complete aggregate command.
  const unit = split(pkg.scripts?.["test:unit"]);
  for (const command of ["npm run test:domain", "npm run test:contracts", "npm run test --workspaces"]) assert.equal(unit.filter(x => x === command).length, 1, `missing blocking aggregate: ${command}`);
  for (const name of ["test:unit", "test:release-tools", "test:e2e", "test:package:e2e", "test:browser"]) {
    const command = pkg.scripts?.[name];
    assert.equal(typeof command, "string", `${name} missing`);
    assert.ok(!/[;|#\n]|(?:^|\s)(?:--passWithNoTests|--testNamePattern|--test-name-pattern|--test-only)(?:\s|=|$)/u.test(command), `unsafe aggregate: ${name}`);
  }
  eq(pkg.scripts["test:e2e"], "node ./scripts/run-e2e.mjs", "transport command must use the reviewed timeout wrapper");
  eq(pkg.scripts["test:package:e2e"], "node scripts/run-package-e2e.mjs", "installed package lane cannot become a version-only smoke");
  eq(pkg.scripts["test:browser"], "node scripts/run-browser-e2e.mjs", "browser lane must check actual execution evidence");
  return { schema_version: 1, critical_checks: Object.keys(CI_CHECKS).length, blocking_jobs: AGGREGATE_JOBS.length, source_only: true };
}
