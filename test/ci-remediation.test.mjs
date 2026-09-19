import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseCi, validateCiWiring } from "../scripts/ci-policy.mjs";
import { CHECK_IDS, CI_CHECKS, AGGREGATE_JOBS, NATIVE_COMMANDS, LTS_COMMANDS, GITLAB_EVENTS, UPLOAD_ACTION, checkCommand } from "../scripts/ci-contract.mjs";
import { gateEvidence, gateJUnit, writeGateReport } from "../scripts/ci-report.mjs";
import { writeSupplement } from "../scripts/ci-supplement.mjs";
import { browserEvidence, REQUIRED_BROWSER_TEST } from "../scripts/browser-evidence.mjs";

function fixture() {
  const pkg = { scripts: { "test:unit": "npm run test:domain && npm run test:contracts && npm run test --workspaces", "test:release-tools": "node --test test/x.test.mjs", "test:e2e": "node ./scripts/run-e2e.mjs", "test:package:e2e": "node scripts/run-package-e2e.mjs", "test:browser": "node scripts/run-browser-e2e.mjs" } };
  const env = Object.fromEntries(AGGREGATE_JOBS.map(name => [name.replaceAll("-", "_").toUpperCase(), `\${{ needs.${name}.result }}`]));
  const gh = { on: { push: { branches: ["main", "dev"] }, pull_request: null, workflow_dispatch: null, workflow_call: null }, permissions: { contents: "read" }, jobs: {
    verify: { "runs-on": "ubuntu-latest", "timeout-minutes": 30, steps: [...CHECK_IDS.map(id => ({ run: checkCommand(id) })), { uses: UPLOAD_ACTION, if: "always()", with: { path: "ci-results/*.json\nci-results/*.xml\n", "if-no-files-found": "error" } }] },
    "native-runner": { strategy: { matrix: { os: ["ubuntu-latest", "windows-latest", "macos-latest"] } }, steps: NATIVE_COMMANDS.map(run => ({ run })) },
    "runner-lts": { strategy: { matrix: { node: ["22.23.2", "24.21.0"] } }, steps: LTS_COMMANDS.map(run => ({ run })) },
    browser: { steps: [{ run: "npm run browser:install" }, { run: "npm run test:browser" }] },
    "verify-all": { if: "always()", needs: [...AGGREGATE_JOBS], steps: [{ env, run: Object.keys(env).map(key => `test "$${key}" = success`).join(" && ") }] },
  } };
  const rules = [...GITLAB_EVENTS.map(expression => ({ if: expression })), { when: "never" }];
  const gl = { workflow: { rules }, verify: { timeout: "30m", script: ["npm install --global npm@10.9.3", ...CHECK_IDS.map(checkCommand)], rules,
    artifacts: { paths: ["ci-results/*.json", "ci-results/*.xml"], when: "always", reports: { junit: "ci-results/*.xml" } } },
    browser: { rules, script: ["npm run browser:install", "npm run test:browser"] } };
  return { pkg, gh, gl };
}
const verify = f => validateCiWiring(f.pkg, stringify(f.gh, { aliasDuplicateObjects: false }), stringify(f.gl, { aliasDuplicateObjects: false }));
test("CI02 normal closed execution grammar is accepted", () => assert.equal(verify(fixture()).critical_checks, CHECK_IDS.length));
for (const [name, mutate] of Object.entries({
  "disabled step": f => f.gh.jobs.verify.steps[0].if = false,
  "dynamic disabled step": f => f.gh.jobs.verify.steps[0].if = "github.event_name == 'never'",
  "soft step failure": f => f.gh.jobs.verify.steps[0]["continue-on-error"] = true,
  "dynamic soft step": f => f.gh.jobs.verify.steps[0]["continue-on-error"] = "${{ true }}",
  "disabled job": f => f.gh.jobs.verify.if = "false",
  "boolean-disabled job": f => f.gh.jobs.verify.if = false,
  "GitHub soft job": f => f.gh.jobs.verify["continue-on-error"] = true,
  "GitLab soft job": f => f.gl.verify.allow_failure = true,
  "GitLab dynamic soft job": f => f.gl.verify.allow_failure = "$SOFT_FAIL",
  "GitLab manual job": f => f.gl.verify.when = "manual",
  "GitLab skipped MR": f => f.gl.verify.rules = [{ when: "never" }],
  "GitLab omitted schedule": f => f.gl.workflow.rules = f.gl.workflow.rules.filter(rule => !rule.if?.includes("schedule")),
  "removed workspace tests": f => f.pkg.scripts["test:unit"] = "npm run test:domain && npm run test:contracts",
  "background workspace tests": f => f.pkg.scripts["test:unit"] += " &",
  "masked unit error": f => f.pkg.scripts["test:unit"] += " || true",
  "test-name filter": f => f.pkg.scripts["test:e2e"] += " --testNamePattern safe",
  "omitted unit check": f => f.gh.jobs.verify.steps = f.gh.jobs.verify.steps.filter(step => step.run !== checkCommand("unit")),
  "duplicated check": f => f.gh.jobs.verify.steps.unshift({ run: checkCommand("unit") }),
  "masked script": f => f.gl.verify.script[1] += " || true",
  "comment-only check": f => f.gh.jobs.verify.steps[0].run = `# ${f.gh.jobs.verify.steps[0].run}`,
  "removed browser dependency": f => f.gh.jobs["verify-all"].needs.pop(),
  "unconditional success aggregate": f => f.gh.jobs["verify-all"].steps[0].run = "true",
  "aggregate skips failures": f => f.gh.jobs["verify-all"].if = "success()",
  "fewer native platforms": f => f.gh.jobs["native-runner"].strategy.matrix.os.pop(),
  "browser optional": f => f.gh.jobs.browser.steps[1].if = "false",
  "native test optional": f => f.gh.jobs["native-runner"].steps[3].if = "false",
  "native soft failure": f => f.gh.jobs["native-runner"].steps[3]["continue-on-error"] = true,
  "missing LTS tests": f => f.gh.jobs["runner-lts"].steps.pop(),
  "browser script is no-op": f => f.pkg.scripts["test:browser"] = "node -e true",
  "package gate is version-only": f => f.pkg.scripts["test:package:e2e"] = "node apps/runner/dist/runmesh.cjs --version",
  "browser missing install": f => f.gh.jobs.browser.steps.shift(),
  "overbroad artifact": f => f.gh.jobs.verify.steps.at(-1).with.path = ".",
  "hidden artifacts": f => f.gh.jobs.verify.steps.at(-1).with["include-hidden-files"] = true,
  "GitLab entire checkout artifact": f => f.gl.verify.artifacts.paths = ["."],
  "checkout credentials": f => f.gh.jobs.verify.steps.push({ uses: "actions/checkout@" + "a".repeat(40), with: { "persist-credentials": true } }),
  "mutable action tag": f => f.gh.jobs.verify.steps.push({ uses: "actions/checkout@main" }),
})) test(`CI02 rejects ${name}`, () => { const f = fixture(); verify(f); mutate(f); assert.throws(() => verify(f)); });
test("CI02 all-comment YAML and duplicate keys cannot create executable proof", () => {
  assert.throws(() => parseCi("# name: check\n# jobs: {}\n"));
  assert.throws(() => parseCi("jobs: {}\njobs: {}\n"));
  assert.throws(() => parseCi("source: &x {}\ncopy: *x\n"));
});
test("CI02 current old configuration is rejected rather than silently upgraded", async () => {
  const base = new URL("../", import.meta.url);
  const read = path => readFile(new URL(path, base), "utf8");
  const gh = await read(".github/workflows/ci.yml");
  // This assertion only applies before integration; the seven mutations above
  // continue to guard the replacement independently of its delivery phase.
  const pkg = JSON.parse(await read("package.json")), gl = await read(".gitlab-ci.yml");
  if (!gh.includes(checkCommand("unit"))) assert.throws(() => validateCiWiring(pkg, gh, gl));
  else validateCiWiring(pkg, gh, gl);
});

const source = { commit: "a".repeat(40), tree: "b".repeat(40), state: "clean", secret: "must-not-export" };
test("CI08 reports gate outcomes, not fictional test counts or private diagnostics", () => {
  const report = gateEvidence("unit", "failed", 123, 7, source);
  assert.equal(report.exit_code, 7); assert.equal(report.test_counts, null);
  assert.ok(!JSON.stringify(report).includes("must-not-export"));
  assert.match(gateJUnit(report), /failures="1"/u);
  assert.match(gateJUnit(gateEvidence("unit", "not_run", 0, null, source)), /skipped="1"/u);
  assert.throws(() => gateEvidence("unit", "passed", 1, 7, source));
  assert.throws(() => gateEvidence("../private", "failed", 1, 1, source));
});
test("CI08 failed attempts replace successful reports atomically", async t => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-ci-report-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeGateReport(gateEvidence("unit", "passed", 1, 0, source), root);
  await writeGateReport(gateEvidence("unit", "failed", 2, 1, source), root);
  assert.equal(JSON.parse(await readFile(join(root, "ci-results/unit.json"), "utf8")).state, "failed");
  assert.match(await readFile(join(root, "ci-results/unit.xml"), "utf8"), /failures="1"/u);
});
test("CI08 a new attempt cannot reuse old successful package/browser/provider summaries", async t => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-ci-summary-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["package-e2e", "browser-tests", "crossforge-evidence"]) {
    await writeSupplement(name, { state: "passed", stale_fixture: true }, root);
    await writeSupplement(name, { state: "not_run", source }, root);
    const report = JSON.parse(await readFile(join(root, `ci-results/${name}.json`), "utf8"));
    assert.equal(report.state, "not_run"); assert.ok(!Object.hasOwn(report, "stale_fixture"));
  }
  await assert.rejects(writeSupplement("private-export", {}, root));
});
test("CI08 cannot overwrite an existing link target", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-ci-link-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeGateReport(gateEvidence("unit", "passed", 1, 0, source), root);
  const target = join(root, "private"), report = join(root, "ci-results/unit.json");
  await writeFile(target, "preserved"); await rm(report); await symlink(target, report);
  await assert.rejects(writeGateReport(gateEvidence("unit", "failed", 1, 1, source), root));
  assert.equal(await readFile(target, "utf8"), "preserved");
});
function rawBrowser() { return { success: true, numFailedTestSuites: 0, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: [{ status: "passed", assertionResults: [{ status: "passed", title: REQUIRED_BROWSER_TEST }] }] }; }
test("CI04 requires the actual named Chromium test, not just exit zero", () => {
  assert.equal(browserEvidence(rawBrowser(), 0).required_browser_checks, 1);
  assert.throws(() => browserEvidence(rawBrowser(), 1));
  const wrong = rawBrowser(); wrong.testResults[0].assertionResults[0].title = "different successful test";
  assert.throws(() => browserEvidence(wrong, 0));
});
test("CI04 missing, skipped, duplicate or TODO browser evidence cannot pass", () => {
  for (const state of ["skipped", "pending", "failed", "todo"]) {
    const raw = rawBrowser(); raw.testResults[0].assertionResults[0].status = state;
    assert.throws(() => browserEvidence(raw, 0));
  }
  const duplicate = rawBrowser(); duplicate.testResults[0].assertionResults.push({ status: "passed", title: REQUIRED_BROWSER_TEST });
  assert.throws(() => browserEvidence(duplicate, 0));
});
