import assert from "node:assert/strict";
import { parseDocument } from "yaml";
import { CI_CHECKS, CHECK_IDS, AGGREGATE_JOBS, NATIVE_COMMANDS, LTS_COMMANDS, checkCommand, UPLOAD_ACTION, GITLAB_EVENTS } from "./ci-contract.mjs";

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
function requiredStep(steps, command) {
  const matches = steps.filter(step => step.run === command);
  assert.equal(matches.length, 1, `missing/duplicate executable step: ${command}`);
  const step = matches[0];
  assert.ok(step.if === undefined && step["continue-on-error"] === undefined && step["working-directory"] === undefined, `conditional/nonblocking critical step: ${command}`);
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
    for (const step of gh.jobs[name].steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with?.["persist-credentials"], false, "checkout must not retain credentials");
      if (step.uses) assert.match(step.uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/u, "actions must use full immutable commits");
    }
  }
  eq(gh.jobs["native-runner"].strategy?.matrix?.os, ["ubuntu-latest", "windows-latest", "macos-latest"], "native platforms removed");
  eq(gh.jobs["runner-lts"].strategy?.matrix?.node, ["22.23.2", "24.21.0"], "supported runtimes changed without contract update");
  for (const command of NATIVE_COMMANDS) requiredStep(gh.jobs["native-runner"].steps, command);
  for (const command of LTS_COMMANDS) requiredStep(gh.jobs["runner-lts"].steps, command);
  requiredStep(gh.jobs.browser.steps, "npm run test:browser");
  requiredStep(gh.jobs.browser.steps, "npm run browser:install");
  const aggregate = gh.jobs["verify-all"];
  eq(aggregate?.needs, [...AGGREGATE_JOBS], "aggregate must include every required job");
  assert.equal(aggregate.if, "always()", "aggregate must run after failure or skip");
  assert.ok(!aggregate["continue-on-error"] && aggregate.steps?.length === 1);
  const env = Object.fromEntries(AGGREGATE_JOBS.map(name => [name.replaceAll("-", "_").toUpperCase(), `\${{ needs.${name}.result }}`]));
  eq(aggregate.steps[0].env, env, "aggregate must consume actual dependency results");
  assert.equal(aggregate.steps[0].run, Object.keys(env).map(key => `test "$${key}" = success`).join(" && "), "aggregate cannot mask failed dependencies");
  const upload = verify.steps.find(s => s.uses === UPLOAD_ACTION);
  assert.ok(upload, "safe result artifact upload missing");
  eq(upload.with?.path, "ci-results/*.json\nci-results/*.xml\n", "artifact scope must remain a report-only whitelist");
  assert.equal(upload.with?.["if-no-files-found"], "error");
  assert.ok(upload.with?.["include-hidden-files"] !== true && upload.with?.overwrite !== true);

  hardJob(gl.verify, "GitLab verify"); hardJob(gl.browser, "GitLab browser");
  rules(gl.workflow?.rules, "GitLab workflow"); rules(gl.verify.rules, "GitLab verify"); rules(gl.browser.rules, "GitLab browser");
  assert.ok(gl.verify.extends === undefined && gl.verify.when === undefined, "unreviewed inherited/manual verification");
  eq(gl.verify.script, ["npm install --global npm@10.9.3", ...CHECK_IDS.map(checkCommand)], "GitLab must execute all checks without shell masking");
  assert.equal(gl.verify.timeout, "30m");
  eq(gl.verify.artifacts?.paths, ["ci-results/*.json", "ci-results/*.xml"], "GitLab artifact whitelist changed");
  assert.equal(gl.verify.artifacts?.when, "always");
  assert.equal(gl.verify.artifacts?.reports?.junit, "ci-results/*.xml");
  assert.ok(gl.browser.script.includes("npm run test:browser") && gl.browser.script.includes("npm run browser:install"));
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
