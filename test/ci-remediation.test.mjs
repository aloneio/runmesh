import { test } from "node:test";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { stringify } from "yaml";
import { parseCi, validateCiWiring } from "../scripts/ci-policy.mjs";
import { CHECK_IDS, CI_CHECKS, AGGREGATE_JOBS, NATIVE_COMMANDS, WINDOWS_TRANSPORT_STEP, WINDOWS_REPORT_INITIALIZATION_STEP, LTS_COMMANDS, BROWSER_COMMANDS, GITLAB_EVENTS, UPLOAD_ACTION, githubReportUpload, gitlabReportArtifacts, checkCommand } from "../scripts/ci-contract.mjs";
import { VERIFY_REPORT_INITIALIZATION_COMMAND } from "../scripts/ci-contract.mjs";
import { gateEvidence, gateJUnit, sourceObservation, writeGateReport } from "../scripts/ci-report.mjs";
import { writeSupplement } from "../scripts/ci-supplement.mjs";
import { browserEvidence, browserFailureEvidence, browserErrorDiagnostic, REQUIRED_BROWSER_TEST } from "../scripts/browser-evidence.mjs";
import { createUiNavigationDiagnostic, uiNavigationDiagnosticMarker, uiNavigationFailureDiagnostic, withUiNavigationDiagnostic } from "../scripts/ui-browser-diagnostics.mjs";
import { closeUiBrowserSocket, createUiBrowserProtocol, waitForUiBrowserEndpoint, waitForUiBrowserSocket, waitForUiNavigation } from "../scripts/ui-browser-check.mjs";
import * as mcpDiagnostics from "../scripts/mcp-diagnostics.mjs";
import { initializeSourceCheckout } from "./helpers/source-checkout.mjs";

test("CI04 stalled Job fixtures retain one bounded phase snapshot without private request state", () => {
  const snapshot = { event: "fixture_progress", fixture: "job_recording", phase: "admin_login_page", boundary: "body", elapsed_ms: 29950 };
  const next = { ...snapshot, fixture: "job_history", phase: "history_restore", boundary: "headers" };
  const marker = value => `RUNMESH_E2E_MCP_WORKER_EVENT=${JSON.stringify(value)}\n`;
  const privateInput = { ...snapshot, url: "https://private.invalid/token", cookie: "private-cookie", stack: "private-stack" };
  assert.equal(mcpDiagnostics.mcpFixtureProgressDiagnostic(privateInput), marker(snapshot));
  assert.deepEqual(mcpDiagnostics.mcpWorkerFailureEvidence(marker(privateInput).repeat(100) + marker(next)), [snapshot, next]);
  for (const changed of [{ fixture: "private" }, { phase: "private" }, { boundary: "private" }, { elapsed_ms: -1 }, { elapsed_ms: 900001 }, { elapsed_ms: 1.5 }]) {
    assert.equal(mcpDiagnostics.mcpFixtureProgressDiagnostic({ ...snapshot, ...changed }), undefined);
    assert.deepEqual(mcpDiagnostics.mcpWorkerFailureEvidence(marker({ ...snapshot, ...changed })), []);
  }
});

function fixture() {
  const pkg = { scripts: { "test:unit": "npm run test:domain && npm run test:contracts && npm run test --workspaces", "test:release-tools": "node --test test/x.test.mjs", "test:e2e": "node ./scripts/run-e2e.mjs", "test:package:e2e": "node scripts/run-package-e2e.mjs", "test:browser": "node scripts/run-browser-e2e.mjs" } };
  const env = Object.fromEntries(AGGREGATE_JOBS.map(name => [name.replaceAll("-", "_").toUpperCase(), `\${{ needs.${name}.result }}`]));
  const gh = { on: { push: { branches: ["main", "dev"] }, pull_request: null, workflow_dispatch: null, workflow_call: null }, permissions: { contents: "read" }, jobs: {
    verify: { "runs-on": "ubuntu-latest", "timeout-minutes": 30, steps: [
      { uses: "actions/setup-node@" + "a".repeat(40), with: { "node-version-file": ".node-version" } },
      { run: VERIFY_REPORT_INITIALIZATION_COMMAND }, ...CHECK_IDS.map(id => ({ run: checkCommand(id) })), githubReportUpload("verify")] },
    "native-runner": { name: "Runner native checks (${{ matrix.os }})", "runs-on": "${{ matrix.os }}", strategy: { matrix: { os: ["ubuntu-latest", "windows-latest", "macos-latest"] } }, steps: [
      { uses: "actions/setup-node@" + "a".repeat(40), with: { "node-version-file": ".node-version" } },
      { ...WINDOWS_REPORT_INITIALIZATION_STEP }, ...NATIVE_COMMANDS.map(run => ({ run })), { ...WINDOWS_TRANSPORT_STEP }, githubReportUpload("native-runner"),
    ] },
    "runner-lts": { name: "Runner LTS (${{ matrix.node }})", strategy: { matrix: { node: ["22.23.2", "24.21.0"] } }, steps: [
      ...LTS_COMMANDS.slice(0, 3).map(run => ({ run })),
      { uses: "actions/setup-node@" + "a".repeat(40), with: { "node-version": "${{ matrix.node }}" } },
      ...LTS_COMMANDS.slice(3).map(run => ({ run })),
    ] },
    browser: { steps: [{ uses: "actions/setup-node@" + "a".repeat(40), with: { "node-version-file": ".node-version" } },
      ...BROWSER_COMMANDS.map(run => ({ run })), githubReportUpload("browser")] },
    "verify-all": { if: "always()", needs: [...AGGREGATE_JOBS], steps: [{ env, run: Object.keys(env).map(key => `test "$${key}" = success`).join(" && ") }] },
  } };
  const rules = [...GITLAB_EVENTS.map(expression => ({ if: expression })), { when: "never" }];
  const gl = { workflow: { rules }, verify: { timeout: "30m", script: [VERIFY_REPORT_INITIALIZATION_COMMAND, "npm install --global npm@10.9.3", ...CHECK_IDS.map(checkCommand)], rules,
    artifacts: gitlabReportArtifacts() },
    browser: { rules, script: [...BROWSER_COMMANDS], artifacts: gitlabReportArtifacts() } };
  return { pkg, gh, gl };
}
const verify = f => validateCiWiring(f.pkg, stringify(f.gh, { aliasDuplicateObjects: false }), stringify(f.gl, { aliasDuplicateObjects: false }));
const browserStep = f => f.gh.jobs.browser.steps.find(step => step.run === "npm run test:browser");
const transportStep = f => f.gh.jobs["native-runner"].steps.find(step => step.run === WINDOWS_TRANSPORT_STEP.run);
const initializationStep = f => f.gh.jobs["native-runner"].steps.find(step => step.run === WINDOWS_REPORT_INITIALIZATION_STEP.run);
test("CI02 normal closed execution grammar is accepted", () => assert.equal(verify(fixture()).critical_checks, CHECK_IDS.length));
test("CI02 accepts an explicit unfiltered pull request trigger", () => {
  const value = fixture(); value.gh.on.pull_request = {};
  assert.equal(verify(value).critical_checks, CHECK_IDS.length);
});
for (const [name, mutate] of Object.entries({
  "push path inclusion": event => event.push.paths = ["docs/**"],
  "push path exclusion": event => event.push["paths-ignore"] = ["apps/**"],
  "pull request path inclusion": event => event.pull_request = { paths: ["docs/**"] },
  "pull request path exclusion": event => event.pull_request = { "paths-ignore": ["apps/**"] },
  "pull request branch inclusion": event => event.pull_request = { branches: ["main"] },
  "pull request branch exclusion": event => event.pull_request = { "branches-ignore": ["dev"] },
  "pull request activity filtering": event => event.pull_request = { types: ["closed"] },
})) test(`CI02 rejects reduced source coverage through ${name}`, () => {
  const value = fixture(); verify(value); mutate(value.gh.on);
  assert.throws(() => verify(value), /source coverage/u);
});
for (const id of ["verify", "browser", "verify-all", "native-runner", "runner-lts"])
test(`CI02 rejects provider evidence name drift for ${id}`, () => {
  const value = fixture(); verify(value);
  value.gh.jobs[id].name = "Renamed " + id;
  assert.throws(() => verify(value));
});
for (const id of ["native-runner", "runner-lts"])
test(`CI02 rejects omitted provider matrix name for ${id}`, () => {
  const value = fixture(); verify(value);
  delete value.gh.jobs[id].name;
  assert.throws(() => verify(value));
});
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
  "GitLab manual browser job": f => f.gl.browser.when = "manual",
  "native job overrides critical shell": f => f.gh.jobs["native-runner"].defaults = { run: { shell: "bash {0} || true" } },
  "LTS job overrides critical shell": f => f.gh.jobs["runner-lts"].defaults = { run: { shell: "bash {0} || true" } },
  "browser job overrides critical shell": f => f.gh.jobs.browser.defaults = { run: { shell: "bash {0} || true" } },
  "aggregate job overrides result-check shell": f => f.gh.jobs["verify-all"].defaults = { run: { shell: "bash {0} || true" } },
  "GitLab skipped MR": f => f.gl.verify.rules = [{ when: "never" }],
  "GitLab omitted schedule": f => f.gl.workflow.rules = f.gl.workflow.rules.filter(rule => !rule.if?.includes("schedule")),
  "removed workspace tests": f => f.pkg.scripts["test:unit"] = "npm run test:domain && npm run test:contracts",
  "background workspace tests": f => f.pkg.scripts["test:unit"] += " &",
  "masked unit error": f => f.pkg.scripts["test:unit"] += " || true",
  "test-name filter": f => f.pkg.scripts["test:e2e"] += " --testNamePattern safe",
  "omitted unit check": f => f.gh.jobs.verify.steps = f.gh.jobs.verify.steps.filter(step => step.run !== checkCommand("unit")),
  "duplicated check": f => f.gh.jobs.verify.steps.unshift({ run: checkCommand("unit") }),
  "masked script": f => f.gl.verify.script[1] += " || true",
  "verification reports are not initialized": f => f.gh.jobs.verify.steps.splice(1, 1),
  "verification reports initialized before Node": f => f.gh.jobs.verify.steps.unshift(f.gh.jobs.verify.steps.splice(1, 1)[0]),
  "verification reports initialized after npm setup": f => f.gh.jobs.verify.steps.splice(1, 0, { run: "npm install --global npm@10.9.3" }),
  "verification report initialization disabled": f => f.gh.jobs.verify.steps[1].if = false,
  "verification report initialization allows failure": f => f.gh.jobs.verify.steps[1]["continue-on-error"] = true,
  "verification report initialization duplicated": f => f.gh.jobs.verify.steps.splice(2, 0, { run: VERIFY_REPORT_INITIALIZATION_COMMAND }),
  "GitLab verification reports are not initialized": f => f.gl.verify.script.shift(),
  "GitLab verification reports initialized after npm setup": f => f.gl.verify.script.splice(1, 0, f.gl.verify.script.shift()),
  "comment-only check": f => f.gh.jobs.verify.steps[0].run = `# ${f.gh.jobs.verify.steps[0].run}`,
  "removed browser dependency": f => f.gh.jobs["verify-all"].needs.pop(),
  "unconditional success aggregate": f => f.gh.jobs["verify-all"].steps[0].run = "true",
  "aggregate skips failures": f => f.gh.jobs["verify-all"].if = "success()",
  "aggregate step skips failed dependencies": f => f.gh.jobs["verify-all"].steps[0].if = "success()",
  "aggregate step masks failed dependencies": f => f.gh.jobs["verify-all"].steps[0]["continue-on-error"] = true,
  "aggregate step overrides the result-check shell": f => f.gh.jobs["verify-all"].steps[0].shell = "bash {0} || true",
  "fewer native platforms": f => f.gh.jobs["native-runner"].strategy.matrix.os.pop(),
  "excluded native platform": f => f.gh.jobs["native-runner"].strategy.matrix.exclude = [{ os: "windows-latest" }],
  "excluded supported runtime": f => f.gh.jobs["runner-lts"].strategy.matrix.exclude = [{ node: "24.21.0" }],
  "native matrix bound to one host": f => f.gh.jobs["native-runner"]["runs-on"] = "ubuntu-latest",
  "LTS matrix bound to one version": f => f.gh.jobs["runner-lts"].steps[3].with["node-version"] = "22.23.2",
  "LTS runtime setup skipped": f => f.gh.jobs["runner-lts"].steps[3].if = false,
  "LTS runtime setup allows failure": f => f.gh.jobs["runner-lts"].steps[3]["continue-on-error"] = true,
  "LTS runtime selected after tests": f => f.gh.jobs["runner-lts"].steps.push(f.gh.jobs["runner-lts"].steps.splice(3, 1)[0]),
  "browser optional": f => browserStep(f).if = "false",
  "browser reports are not initialized": f => f.gh.jobs.browser.steps.splice(1, 1),
  "browser reports initialized before Node": f => f.gh.jobs.browser.steps.unshift(f.gh.jobs.browser.steps.splice(1, 1)[0]),
  "browser reports initialized after npm setup": f => f.gh.jobs.browser.steps.splice(2, 0, f.gh.jobs.browser.steps.splice(1, 1)[0]),
  "browser report initialization disabled": f => f.gh.jobs.browser.steps[1].if = false,
  "browser report initialization allows failure": f => f.gh.jobs.browser.steps[1]["continue-on-error"] = true,
  "browser report initialization overrides shell": f => f.gh.jobs.browser.steps[1].shell = "bash {0} || true",
  "browser report initialization duplicated": f => f.gh.jobs.browser.steps.splice(2, 0, { run: BROWSER_COMMANDS[0] }),
  "browser Node setup missing": f => f.gh.jobs.browser.steps.shift(),
  "browser Node setup disabled": f => f.gh.jobs.browser.steps[0].if = false,
  "browser Node setup allows failure": f => f.gh.jobs.browser.steps[0]["continue-on-error"] = true,
  "browser Node setup changes runtime": f => f.gh.jobs.browser.steps[0].with["node-version-file"] = "package.json",
  "GitLab browser reports are not initialized": f => f.gl.browser.script.shift(),
  "GitLab browser reports initialized after npm setup": f => f.gl.browser.script.splice(1, 0, f.gl.browser.script.shift()),
  "browser test is commented": f => browserStep(f).run = "# npm run test:browser",
  "browser test masks failure": f => browserStep(f).run += " || true",
  "browser test allows failure": f => browserStep(f)["continue-on-error"] = true,
  "browser test overrides shell": f => browserStep(f).shell = "bash {0} || true",
  "browser preparation reordered": f => f.gh.jobs.browser.steps.reverse(),
  "browser missing build": f => f.gh.jobs.browser.steps = f.gh.jobs.browser.steps.filter(step => step.run !== "npm run build"),
  "GitLab browser commands only appear in scalar comments": f => f.gl.browser.script = "# npm run browser:install\n# npm run test:browser\ntrue",
  "GitLab browser scalar masks failures": f => f.gl.browser.script = "npm run browser:install || true\nnpm run test:browser || true",
  "GitLab browser test masks failure": f => f.gl.browser.script[f.gl.browser.script.length - 1] += " || true",
  "GitLab browser missing build": f => f.gl.browser.script = f.gl.browser.script.filter(command => command !== "npm run build"),
  "GitLab browser preparation reordered": f => f.gl.browser.script.reverse(),
  "GitLab browser duplicated test": f => f.gl.browser.script.push("npm run test:browser"),
  "Windows transport missing": f => f.gh.jobs["native-runner"].steps = f.gh.jobs["native-runner"].steps.filter(step => step.run !== WINDOWS_TRANSPORT_STEP.run),
  "Windows transport runs on another platform": f => transportStep(f).if = "matrix.os == 'ubuntu-latest'",
  "Windows transport disabled": f => transportStep(f).if = false,
  "Windows transport masks failure": f => transportStep(f).run += " || true",
  "Windows transport allows failure": f => transportStep(f)["continue-on-error"] = true,
  "Windows transport overrides shell": f => transportStep(f).shell = "pwsh -Command {0}; exit 0",
  "Windows transport duplicated": f => f.gh.jobs["native-runner"].steps.push({ ...WINDOWS_TRANSPORT_STEP }),
  "Windows reports are not initialized": f => f.gh.jobs["native-runner"].steps = f.gh.jobs["native-runner"].steps.filter(step => step.run !== WINDOWS_REPORT_INITIALIZATION_STEP.run),
  "Windows reports initialized on every platform": f => delete initializationStep(f).if,
  "Windows report initialization disabled": f => initializationStep(f).if = false,
  "Windows report initialization allows failure": f => initializationStep(f)["continue-on-error"] = true,
  "Windows report initialization overrides shell": f => initializationStep(f).shell = "pwsh -Command {0}; exit 0",
  "Windows report initialization duplicated": f => f.gh.jobs["native-runner"].steps.splice(2, 0, { ...WINDOWS_REPORT_INITIALIZATION_STEP }),
  "Windows reports initialized before Node": f => f.gh.jobs["native-runner"].steps.unshift(f.gh.jobs["native-runner"].steps.splice(1, 1)[0]),
  "Windows reports initialized after npm ci": f => f.gh.jobs["native-runner"].steps.splice(2, 0, f.gh.jobs["native-runner"].steps.splice(1, 1)[0]),
  "Windows reports initialized after npm setup": f => f.gh.jobs["native-runner"].steps.splice(1, 0, { run: "npm install --global npm@10.9.3" }),
  "native Node setup missing": f => f.gh.jobs["native-runner"].steps.shift(),
  "native Node setup disabled": f => f.gh.jobs["native-runner"].steps[0].if = false,
  "native Node setup allows failure": f => f.gh.jobs["native-runner"].steps[0]["continue-on-error"] = true,
  "native test optional": f => f.gh.jobs["native-runner"].steps[3].if = "false",
  "native soft failure": f => f.gh.jobs["native-runner"].steps[3]["continue-on-error"] = true,
  "missing LTS tests": f => f.gh.jobs["runner-lts"].steps.pop(),
  "browser script is no-op": f => f.pkg.scripts["test:browser"] = "node -e true",
  "package gate is version-only": f => f.pkg.scripts["test:package:e2e"] = "node apps/runner/dist/runmesh.cjs --version",
  "browser missing install": f => f.gh.jobs.browser.steps = f.gh.jobs.browser.steps.filter(step => step.run !== "npm run browser:install"),
  "LTS uploads nonexistent reports": f => f.gh.jobs["runner-lts"].steps.push(githubReportUpload("verify")),
  "checkout credentials": f => f.gh.jobs.verify.steps.push({ uses: "actions/checkout@" + "a".repeat(40), with: { "persist-credentials": true } }),
  "mutable action tag": f => f.gh.jobs.verify.steps.push({ uses: "actions/checkout@main" }),
})) test(`CI02 rejects ${name}`, () => { const f = fixture(); verify(f); mutate(f); assert.throws(() => verify(f)); });

for (const lane of ["verify", "browser", "native-runner"]) {
  for (const [name, mutate] of Object.entries({
    "missing upload": job => job.steps.pop(),
    "duplicate upload": (job, upload) => job.steps.push(structuredClone(upload)),
    "upload before tests": job => job.steps.unshift(job.steps.pop()),
    "success-only upload": (_job, upload) => upload.if = "success()",
    "disabled upload": (_job, upload) => upload.if = false,
    "soft upload failure": (_job, upload) => upload["continue-on-error"] = true,
    "upload execution override": (_job, upload) => upload.env = { INPUT_PATH: "." },
    "mutable upload action": (_job, upload) => upload.uses = "actions/upload-artifact@main",
    "raw output upload": (_job, upload) => upload.with.path = "ci-results/**",
    "hidden output upload": (_job, upload) => upload.with["include-hidden-files"] = true,
    "missing artifact identity": (_job, upload) => delete upload.with.name,
    "shared artifact identity": (_job, upload) => upload.with.name = "ci-results",
    "ignored missing reports": (_job, upload) => upload.with["if-no-files-found"] = "ignore",
    "overwritten report artifact": (_job, upload) => upload.with.overwrite = true,
    "changed report retention": (_job, upload) => upload.with["retention-days"] = 90,
    "unarchived reports": (_job, upload) => upload.with.archive = false,
  })) test(`CI08 rejects ${lane} ${name}`, () => {
    const f = fixture(), job = f.gh.jobs[lane]; verify(f);
    mutate(job, job.steps.find(step => step.uses === UPLOAD_ACTION));
    assert.throws(() => verify(f));
  });
}
test("CI08 native reports are only expected from Windows transport", () => {
  const f = fixture();
  f.gh.jobs["native-runner"].steps.find(step => step.uses === UPLOAD_ACTION).if = "always()";
  assert.throws(() => verify(f));
});
for (const lane of ["verify", "browser"]) {
  for (const [name, mutate] of Object.entries({
    "missing artifacts": job => delete job.artifacts,
    "success-only artifacts": job => job.artifacts.when = "on_success",
    "entire checkout artifacts": job => job.artifacts.paths = ["."],
    "untracked artifacts": job => job.artifacts.untracked = true,
    "private dotenv report": job => job.artifacts.reports.dotenv = "private.env",
    "missing JUnit report": job => delete job.artifacts.reports.junit,
    "changed report retention": job => job.artifacts.expire_in = "90 days",
  })) test(`CI08 rejects GitLab ${lane} ${name}`, () => {
    const f = fixture(); verify(f); mutate(f.gl[lane]); assert.throws(() => verify(f));
  });
}
test("CI02 all-comment YAML and duplicate keys cannot create executable proof", () => {
  assert.throws(() => parseCi("# name: check\n# jobs: {}\n"));
  assert.throws(() => parseCi("jobs: {}\njobs: {}\n"));
  assert.throws(() => parseCi("source: &x {}\ncopy: *x\n"));
});

test("CI02 native provenance regressions remain a mandatory cross-platform command", async () => {
  const base = new URL("../", import.meta.url);
  const read = path => readFile(new URL(path, base), "utf8");
  const pkg = JSON.parse(await read("package.json")), github = parseCi(await read(".github/workflows/ci.yml"));
  const gitlab = await read(".gitlab-ci.yml");
  const command = "node --test test/build-provenance.test.mjs test/deployment-provenance-cli.test.mjs test/live-provenance.test.mjs";
  assert.equal(github.jobs["native-runner"].steps.filter(step => step.run === command).length, 1);
  validateCiWiring(pkg, stringify(github), gitlab);
  github.jobs["native-runner"].steps = github.jobs["native-runner"].steps.filter(step => step.run !== command);
  assert.throws(() => validateCiWiring(pkg, stringify(github), gitlab));
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
for (const id of ["verify", "transport", "browser"]) test(`CI08 ${id} initialization creates and resets only its evidence before dependency installation`, async t => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-ci-initialize-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  for (const name of ["ci-check.mjs", "ci-contract.mjs", "ci-report.mjs", "source-git.mjs", "ci-supplement.mjs", "test-evidence.mjs", "evidence-io.mjs", "windows-tools.mjs", "mcp-diagnostics.mjs", "ui-browser-contract.mjs", "ui-browser-diagnostics.mjs"])
    await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root, "scripts", name));
  const initialize = () => {
    const result = spawnSync(process.execPath, [join(root, "scripts/ci-check.mjs"), "--initialize", id], { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  const gates = id === "verify" ? CHECK_IDS : [id];
  const supplements = id === "verify" ? ["package-e2e", "browser-tests", "transport-tests", "crossforge-evidence"] : [`${id}-tests`];
  initialize();
  assert.deepEqual((await readdir(join(root, "ci-results"))).sort(), [...gates.flatMap(name => [`${name}.json`, `${name}.xml`]), ...supplements.map(name => `${name}.json`)].sort());
  for (const name of gates) await writeGateReport(gateEvidence(name, "passed", 1, 0, source), root);
  for (const name of supplements) await writeSupplement(name, { state: "passed", stale_fixture: true }, root);
  initialize();
  const observation = JSON.parse(await readFile(join(root, `ci-results/${gates[0]}.json`), "utf8")).source;
  for (const name of gates) {
    const gate = JSON.parse(await readFile(join(root, `ci-results/${name}.json`), "utf8"));
    assert.equal(gate.state, "not_run"); assert.equal(gate.exit_code, null); assert.equal(gate.elapsed_ms, 0); assert.equal(gate.test_counts, null);
    assert.deepEqual(gate.source, observation);
    assert.match(await readFile(join(root, `ci-results/${name}.xml`), "utf8"), /failures="0" skipped="1"/u);
  }
  for (const name of supplements) {
    const supplement = JSON.parse(await readFile(join(root, `ci-results/${name}.json`), "utf8"));
    assert.deepEqual(supplement, { schema_version: 1, state: "not_run", source: observation });
  }
  const invalid = spawnSync(process.execPath, [join(root, "scripts/ci-check.mjs"), "--initialize", "toolchain"], { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.notEqual(invalid.status, 0);
});

async function ciFailureFixture(t, id, command, stop = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-ci-failure-"));
  t.after(async () => { try { await stop(); } finally { await rm(root, { recursive: true, force: true }); } });
  await mkdir(join(root, "scripts"));
  for (const name of ["ci-check.mjs", "ci-report.mjs", "source-git.mjs", "ci-supplement.mjs", "test-evidence.mjs", "evidence-io.mjs", "windows-tools.mjs", "mcp-diagnostics.mjs", "ui-browser-contract.mjs", "ui-browser-diagnostics.mjs"])
    await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root, "scripts", name));
  await writeFile(join(root, "scripts/ci-contract.mjs"), `export const CI_CHECKS=${JSON.stringify({ [id]: command })}; export const CHECK_IDS=Object.keys(CI_CHECKS);\n`);
  await writeFile(join(root, "scripts/fixture-pass.mjs"), "process.exitCode = 0;\n");
  return { root, run: () => spawnSync(process.execPath, [join(root, "scripts/ci-check.mjs"), id], { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true }) };
}

for (const exitCode of [0, 7]) test(`CI gate source changes cannot publish stale success after child exit ${exitCode}`, async t => {
  const f = await ciFailureFixture(t, "tooling", "node scripts/fixture-source.mjs");
  await writeFile(join(f.root, "scripts/fixture-source.mjs"), `import { writeFileSync } from 'node:fs'; writeFileSync('source.txt', 'changed'); process.exitCode = ${exitCode};\n`);
  const { source } = await initializeSourceCheckout(f.root);
  const result = f.run(), gate = JSON.parse(await readFile(join(f.root, "ci-results/tooling.json"), "utf8"));
  assert.equal(result.status, exitCode || 1);
  assert.equal(gate.state, "failed"); assert.equal(gate.exit_code, exitCode || 1); assert.deepEqual(gate.source, source);
  if (exitCode === 0) assert.match(result.stderr, /phase=source_validation reason=invalid_evidence/u);
  else assert.doesNotMatch(result.stderr, /source_validation/u, "retain the original process failure");
});

test("CI gate preserves success when the source observation stays unchanged", async t => {
  const f = await ciFailureFixture(t, "tooling", "node scripts/fixture-pass.mjs");
  const { source } = await initializeSourceCheckout(f.root);
  const result = f.run(), gate = JSON.parse(await readFile(join(f.root, "ci-results/tooling.json"), "utf8"));
  assert.equal(result.status, 0, result.stderr); assert.equal(gate.state, "passed"); assert.deepEqual(gate.source, source);
});

test("CI08 cancellation finishes terminating the process group after the gate child exits", { skip: process.platform === "win32", timeout: 15000 }, async t => {
  let gate, parentPid, exited;
  const f = await ciFailureFixture(t, "tooling", "node scripts/fixture-parent.mjs", async () => {
    if (Number.isSafeInteger(parentPid) && parentPid > 0) { try { process.kill(-parentPid, "SIGKILL"); } catch { /* already terminated */ } }
    if (gate?.exitCode === null && gate.signalCode === null) gate.kill("SIGKILL");
    await exited;
  });
  const heartbeat = join(f.root, "heartbeat"), ready = join(f.root, "ready"), parent = join(f.root, "parent");
  await writeFile(join(f.root, "scripts/fixture-descendant.mjs"), `
    import { writeFileSync } from 'node:fs';
    let count = 0;
    process.on('SIGTERM', () => {});
    setInterval(() => writeFileSync(${JSON.stringify(heartbeat)}, String(++count)), 25);
    writeFileSync(${JSON.stringify(ready)}, 'ready');
  `);
  await writeFile(join(f.root, "scripts/fixture-parent.mjs"), `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(parent)}, String(process.pid));
    process.on('SIGTERM', () => process.exit(0));
    spawn(process.execPath, ['scripts/fixture-descendant.mjs'], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `);
  gate = spawn(process.execPath, [join(f.root, "scripts/ci-check.mjs"), "tooling"], { cwd: f.root, stdio: "ignore" });
  exited = new Promise(resolve => { gate.once("exit", code => resolve(code)); gate.once("error", () => resolve(-1)); });
  const deadline = Date.now() + 5000;
  while (true) {
    const observedPid = await readFile(parent, "utf8").then(Number, () => undefined);
    if (Number.isSafeInteger(observedPid) && observedPid > 0) parentPid = observedPid;
    if (await readFile(ready, "utf8").then(() => true, () => false)) break;
    assert.ok(Date.now() < deadline, "descendant must become ready");
    await delay(25);
  }
  parentPid = Number(await readFile(parent, "utf8"));
  assert.ok(Number.isSafeInteger(parentPid) && parentPid > 0);
  gate.kill("SIGTERM");
  const stoppedBy = Date.now() + 5000;
  while (gate.exitCode === null && gate.signalCode === null) {
    assert.ok(Date.now() < stoppedBy, "cancelled gate must exit");
    await delay(25);
  }
  assert.equal(await exited, 1);
  const report = JSON.parse(await readFile(join(f.root, "ci-results/tooling.json"), "utf8"));
  assert.equal(report.state, "cancelled");
  const before = await readFile(heartbeat, "utf8").catch(() => "");
  await delay(150);
  assert.equal(await readFile(heartbeat, "utf8").catch(() => ""), before, "cancelled gate must not leave an executing descendant");
});

test("CI08 missing gate executable reports a safe process-start diagnostic", async t => {
  const f = await ciFailureFixture(t, "tooling", "runmesh-ci-missing-executable-fixture");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RUNMESH_CI_GATE_ERROR gate=tooling phase=process_start reason=ENOENT/u);
  assert.equal(result.stderr.includes(f.root), false);
  assert.equal(result.stderr.includes("runmesh-ci-missing-executable-fixture"), false);
  const gate = JSON.parse(await readFile(join(f.root, "ci-results/tooling.json"), "utf8"));
  assert.equal(gate.state, "failed"); assert.equal(gate.exit_code, 1);
});

for (const [name, body, phase, reason] of [
  ["missing", undefined, "package_evidence_read", "ENOENT"],
  ["invalid JSON", "{PRIVATE_EVIDENCE_TEXT", "package_evidence_read", "invalid_json"],
  ["invalid envelope", JSON.stringify({ runtime: { node: "PRIVATE_RUNTIME_TEXT" } }), "package_evidence_validate", "invalid_evidence"],
  ["source mismatch", JSON.stringify({ tests: { state: "passed", total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, files: 1 },
    source: { commit: "a".repeat(40), tree: "b".repeat(40), state: "clean" }, artifact: { sha256: "c".repeat(64), bytes: 1 },
    runtime: { platform: "linux", arch: "x64", node: "v22.23.2" }, elapsed_ms: 1 }), "package_evidence_source", "invalid_evidence"],
]) test(`CI08 ${name} package evidence reports the failed phase`, async t => {
  const f = await ciFailureFixture(t, "installed_transport", "node scripts/fixture-pass.mjs");
  if (body !== undefined) { await mkdir(join(f.root, ".verification")); await writeFile(join(f.root, ".verification/package-e2e.json"), body); }
  const result = f.run();
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`RUNMESH_CI_GATE_ERROR gate=installed_transport phase=${phase} reason=${reason}`), result.stderr);
  assert.equal(result.stderr.includes(f.root), false);
  assert.equal(result.stderr.includes("PRIVATE_"), false);
  const gate = JSON.parse(await readFile(join(f.root, "ci-results/installed_transport.json"), "utf8"));
  const supplement = JSON.parse(await readFile(join(f.root, "ci-results/package-e2e.json"), "utf8"));
  assert.equal(gate.state, "failed"); assert.equal(gate.exit_code, 1); assert.equal(supplement.state, "not_run");
});

for (const observer of ["gate", "release"]) for (const boundary of ["commit", "status"]) test(`CI08 ${observer} source observation rejects a checkout changed after reading ${boundary}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "runmesh-source-observation-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const checkout = join(directory, "checkout"); await mkdir(checkout);
  if (observer === "release") {
    await mkdir(join(checkout, "scripts/dev-release"), { recursive: true });
    for (const file of ["dev-release/io.mjs", "dev-release/policy.mjs", "dev-release/baseline-policy.mjs", "ci-report.mjs", "source-git.mjs", "evidence-io.mjs"])
      await writeFile(join(checkout, "scripts", file), await readFile(new URL("../scripts/" + file, import.meta.url)));
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=Runmesh Test", "-c", "user.email=runmesh-test@example.test",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + join(directory, "no-hooks"), ...args],
    { cwd: checkout, env, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git("init", "--quiet");
  await writeFile(join(checkout, "source.txt"), "first\n"); git("add", "."); git("commit", "--quiet", "-m", "first");
  const first = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
  // An empty commit preserves the tree and exposes release checks that compare
  // commit/tree separately but never confirm the final checkout identity.
  if (observer === "gate") await writeFile(join(checkout, "source.txt"), "second\n");
  git("add", "."); git("commit", "--quiet", "--allow-empty", "-m", "second");
  const second = git("rev-parse", "HEAD"); git("checkout", "--quiet", first);
  const preload = join(directory, "change-checkout.mjs");
  // Instrument the public process boundary in an isolated child. Every Git
  // operation is real and the checkout belongs only to this test.
  await writeFile(preload, `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { promisify } from "node:util";
    const original = childProcess.execFileSync; let changed = false;
    const afterRead = (file, args, options) => {
      const boundary = ${JSON.stringify(boundary)};
      if (!changed && file === "git" && (boundary === "commit" ? args.at(-1) === "HEAD" : args.includes("status"))) {
        changed = true; original("git", ["checkout", "--quiet", ${JSON.stringify(second)}], options);
      }
    };
    childProcess.execFileSync = (file, args, options) => {
      const output = original(file, args, options); afterRead(file, args, options);
      return output;
    };
    const originalExecFile = childProcess.execFile, originalAsync = promisify(originalExecFile);
    childProcess.execFile = (...args) => originalExecFile(...args);
    childProcess.execFile[promisify.custom] = async (file, args, options) => {
      const output = await originalAsync(file, args, options); afterRead(file, args, options); return output;
    };
    syncBuiltinESMExports();
  `);
  const moduleUrl = observer === "gate" ? new URL("../scripts/ci-report.mjs", import.meta.url).href : pathToFileURL(join(checkout, "scripts/dev-release/io.mjs")).href;
  const probe = observer === "gate"
    ? `import { sourceObservation } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(sourceObservation(process.cwd())));`
    : `import { assertSource } from ${JSON.stringify(moduleUrl)}; const accepted = await assertSource(${JSON.stringify({ source_sha: first, source_tree: tree })}).then(()=>true,()=>false); console.log(JSON.stringify({accepted}));`;
  if (observer === "release") {
    const unchanged = spawnSync(process.execPath, ["--input-type=module", "-e", probe],
      { cwd: checkout, env, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.deepEqual(JSON.parse(unchanged.stdout), { accepted: true }, "matching clean release source remains accepted");
  }
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "--input-type=module", "-e",
    probe],
  { cwd: checkout, env, encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), observer === "gate" ? { commit: null, tree: null, state: "unknown" } : { accepted: false });
  assert.equal(git("rev-parse", "HEAD"), second, "fixture must actually change the checkout");
});

test("CI08 source observation binds to the requested checkout despite inherited Git routing", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runmesh-source-routing-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const create = async name => {
    const root = join(directory, name); await mkdir(root);
    const git = (...args) => {
      const result = spawnSync("git", ["-c", "user.name=Runmesh Test", "-c", "user.email=runmesh-test@example.test",
        "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + join(directory, "no-hooks"), ...args],
      { cwd: root, env, encoding: "utf8", timeout: 15000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    git("init", "--quiet"); await writeFile(join(root, "source.txt"), name); git("add", "."); git("commit", "--quiet", "-m", name);
    return { root, source: { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), state: "clean" } };
  };
  const requested = await create("requested"), other = await create("other");
  assert.notEqual(requested.source.commit, other.source.commit);
  const observe = (root, environment = env) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { sourceObservation } from ${JSON.stringify(new URL("../scripts/ci-report.mjs", import.meta.url).href)}; console.log(JSON.stringify(sourceObservation(process.cwd())));`],
    { cwd: root, env: environment, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  assert.deepEqual(observe(requested.root), requested.source);
  await writeFile(join(requested.root, "source.txt"), "uncommitted source");
  const routed = { ...env, GIT_DIR: join(other.root, ".git"), GIT_WORK_TREE: other.root, GIT_INDEX_FILE: join(other.root, ".git/index") };
  assert.deepEqual(observe(requested.root, routed), { ...requested.source, state: "dirty" });
  const nested = join(requested.root, "nested"); await mkdir(nested);
  assert.deepEqual(observe(nested), { commit: null, tree: null, state: "unknown" });
});

for (const changed of ["tree", "state"]) test(`CI08 installed package evidence must match the observed source ${changed}`, async t => {
  const f = await ciFailureFixture(t, "installed_transport", "node scripts/fixture-pass.mjs");
  await writeFile(join(f.root, ".gitignore"), ".verification/\nci-results/\n");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: f.root, encoding: "utf8", timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "--quiet"); git("add", ".");
  git("-c", "user.name=Runmesh Test", "-c", "user.email=runmesh-test@example.test", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=" + join(f.root, ".git/no-hooks"), "commit", "--quiet", "-m", "fixture source");
  const observed = sourceObservation(f.root);
  assert.equal(observed.state, "clean");
  const evidence = { tests: { state: "passed", total: 1, passed: 1, failed: 0, skipped: 0, todo: 0, files: 1 },
    source: observed, artifact: { sha256: "c".repeat(64), bytes: 1 },
    runtime: { platform: process.platform, arch: process.arch, node: process.version }, elapsed_ms: 1 };
  await mkdir(join(f.root, ".verification"));
  const write = () => writeFile(join(f.root, ".verification/package-e2e.json"), JSON.stringify(evidence));
  await write();
  const matching = f.run(); assert.equal(matching.status, 0, matching.stderr);
  assert.equal(JSON.parse(await readFile(join(f.root, "ci-results/installed_transport.json"), "utf8")).state, "passed");
  evidence.source = { ...observed, [changed]: changed === "tree" ? "0".repeat(40) : "dirty" };
  await write();
  const mismatched = f.run();
  assert.equal(mismatched.status, 1, "A matching commit must not hide a different tree or worktree state");
  assert.match(mismatched.stderr, /RUNMESH_CI_GATE_ERROR gate=installed_transport phase=package_evidence_source reason=invalid_evidence/u);
  assert.equal(mismatched.stderr.includes(f.root), false);
  const gate = JSON.parse(await readFile(join(f.root, "ci-results/installed_transport.json"), "utf8"));
  const supplement = JSON.parse(await readFile(join(f.root, "ci-results/package-e2e.json"), "utf8"));
  assert.equal(gate.state, "failed"); assert.deepEqual(gate.source, observed);
  assert.equal(supplement.state, "not_run");
  if (changed === "state") {
    await writeFile(join(f.root, "scripts/fixture-pass.mjs"), "// Local edits are valid when both observations agree.\nprocess.exitCode = 0;\n");
    evidence.source = sourceObservation(f.root); assert.equal(evidence.source.state, "dirty");
    await write();
    const local = f.run(); assert.equal(local.status, 0, local.stderr);
    const localGate = JSON.parse(await readFile(join(f.root, "ci-results/installed_transport.json"), "utf8"));
    assert.equal(localGate.state, "passed"); assert.deepEqual(localGate.source, evidence.source);
  }
});

test("CI08 a new attempt cannot reuse old successful package/browser/transport/provider summaries", async t => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-ci-summary-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["package-e2e", "browser-tests", "transport-tests", "crossforge-evidence"]) {
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
for (const status of ["constructor", "__proto__", "toString", ["passed"]])
test("CI04 browser evidence rejects malformed auxiliary status " + JSON.stringify(status), () => {
  const raw = rawBrowser(); raw.numTotalTests++;
  if (Array.isArray(status)) raw.numPassedTests++;
  raw.testResults[0].assertionResults.push({ status, title: "auxiliary test" });
  assert.throws(() => browserEvidence(raw, 0), /unknown\/incomplete test result/u);
});
test("CI04 missing, skipped, duplicate or TODO browser evidence cannot pass", () => {
  for (const state of ["skipped", "pending", "failed", "todo"]) {
    const raw = rawBrowser(); raw.testResults[0].assertionResults[0].status = state;
    assert.throws(() => browserEvidence(raw, 0));
  }
  const duplicate = rawBrowser(); duplicate.testResults[0].assertionResults.push({ status: "passed", title: REQUIRED_BROWSER_TEST });
  assert.throws(() => browserEvidence(duplicate, 0));
});

function navigationFixture() {
  const state = { url: "http://127.0.0.1:1234/admin?lang=zh-CN", locale: "zh-CN", loaderId: "new-document",
    readyState: "complete", initialized: true, loading: false };
  const fixture = { state, elapsed: 0, polls: 0, evaluatedLoaders: [], budgets: [], onPause() {}, evaluateError: undefined };
  fixture.clock = { now: () => fixture.elapsed, pause: async milliseconds => {
    fixture.elapsed += milliseconds; fixture.polls++; await fixture.onPause();
  } };
  fixture.tab = async (method, params, budget) => {
    fixture.budgets.push(budget);
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame", loaderId: state.loaderId, url: state.frameUrl ?? state.url } } };
    assert.equal(method, "Runtime.evaluate");
    if (fixture.evaluateError) { const error = fixture.evaluateError; fixture.evaluateError = undefined; throw error; }
    fixture.evaluatedLoaders.push(state.loaderId);
    return { result: { value: runInNewContext(params.expression, {
      location: new URL(state.url), document: { readyState: state.readyState, documentElement: { lang: state.locale,
        getAttribute: name => name === "data-runmesh-navigation" ? state.initialized ? "ready" : null : String(state.loading) } },
    }) } };
  };
  return fixture;
}

function browserProtocolFixture() {
  const socket = new EventEmitter(), child = new EventEmitter(), sent = [];
  child.exitCode = null; child.signalCode = null; child.stderr = new EventEmitter();
  socket.send = (payload, callback) => { sent.push(JSON.parse(payload)); callback?.(); };
  const protocol = createUiBrowserProtocol(socket, child, { stage: () => "dashboard_initial" });
  protocol.setTarget("owned-target", "owned-session");
  return { socket, child, sent, protocol };
}

test("CI04 browser lifecycle failures reject pending and future calls without another send", async () => {
  for (const [event, expected] of [
    [h => h.socket.emit("close"), "Browser connection closed"],
    [h => h.socket.emit("error", new Error("private socket details")), "Browser socket error"],
    [h => h.child.emit("exit", 1, null), "Browser process exited"],
    [h => h.child.emit("error", new Error("private process details")), "Browser process failed"],
    [h => h.socket.emit("message", JSON.stringify({ method: "Inspector.targetCrashed", sessionId: "owned-session" })), "Browser renderer crashed"],
    [h => h.socket.emit("message", JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "owned-session" } })), "Browser target detached"],
  ]) {
    const h = browserProtocolFixture();
    try {
      const pending = h.protocol.call("Runtime.evaluate", { expression: "private fixture" }, "owned-session");
      const rejected = assert.rejects(pending, { message: `${expected} (stage: dashboard_initial)` });
      event(h); await rejected;
      await assert.rejects(h.protocol.call("Runtime.evaluate"), { message: `${expected} (stage: dashboard_initial)` });
      assert.equal(h.sent.length, 1);
    } finally { h.protocol.dispose(); }
    assert.equal(h.socket.listenerCount("message"), 0);
    assert.equal(h.child.listenerCount("exit"), 0);
  }
});

test("CI04 unrelated browser targets and remote context errors preserve the live connection", async () => {
  const h = browserProtocolFixture();
  try {
    const first = h.protocol.call("Runtime.evaluate", {}, "owned-session");
    h.socket.emit("message", JSON.stringify({ method: "Inspector.targetCrashed", sessionId: "other-session" }));
    h.socket.emit("message", JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "other-session" } }));
    const rejected = assert.rejects(first, error => error.code === -32000 && error.message === "Execution context was destroyed.");
    h.socket.emit("message", JSON.stringify({ id: h.sent[0].id, error: { code: -32000, message: "Execution context was destroyed." } }));
    await rejected;
    const second = h.protocol.call("Page.getFrameTree");
    h.socket.emit("message", JSON.stringify({ id: h.sent[1].id, result: { ready: true } }));
    assert.deepEqual(await second, { ready: true });
    assert.equal(h.sent.length, 2);
  } finally { h.protocol.dispose(); }
});

test("CI04 browser request timeouts keep the initiating stage and never replay a request", async () => {
  const h = browserProtocolFixture(); h.protocol.dispose();
  let stage = "dashboard_initial";
  const protocol = createUiBrowserProtocol(h.socket, h.child, { stage: () => stage });
  try {
    const pending = protocol.call("Runtime.evaluate", { expression: "private fixture" }, undefined, 5);
    stage = "browser_close";
    await assert.rejects(pending, { message: "Browser operation timed out: Runtime.evaluate (stage: dashboard_initial)" });
    assert.equal(h.sent.length, 1);
  } finally { protocol.dispose(); }
});

test("CI04 failed browser sends expose controlled diagnostics and settle all pending calls", async () => {
  const h = browserProtocolFixture();
  try {
    h.socket.send = (_payload, callback) => callback(new Error("private socket details"));
    await assert.rejects(h.protocol.call("Runtime.evaluate"), { message: "Browser request send failed (stage: dashboard_initial)" });
  } finally { h.protocol.dispose(); }
});

test("CI04 browser startup and socket connection reject process exit before their deadline", async () => {
  const h = browserProtocolFixture(); h.protocol.dispose();
  const endpoint = waitForUiBrowserEndpoint(h.child);
  const startupRejected = assert.rejects(endpoint, { message: "Browser process exited (stage: browser_startup)" });
  h.child.emit("exit", 1, null); await startupRejected;
  assert.equal(h.child.stderr.listenerCount("data"), 0);
  assert.equal(h.child.listenerCount("error"), 0);
  const opening = waitForUiBrowserSocket(h.socket, h.child);
  const connectionRejected = assert.rejects(opening, { message: "Browser connection closed (stage: browser_connect)" });
  h.socket.emit("close"); await connectionRejected;
  assert.equal(h.socket.listenerCount("open"), 0);
  assert.equal(h.socket.listenerCount("error"), 0);
  assert.equal(h.child.listenerCount("exit"), 0);
});

test("CI04 cleanup absorbs a connecting socket's asynchronous close error until it closes", async () => {
  const h = browserProtocolFixture(); h.protocol.dispose();
  h.socket.close = () => queueMicrotask(() => {
    h.socket.emit("error", new Error("WebSocket was closed before the connection was established"));
    h.socket.emit("close");
  });
  await assert.rejects(waitForUiBrowserSocket(h.socket, h.child, 5), /Browser connection timed out/u);
  const closed = new Promise(resolve => h.socket.once("close", resolve));
  closeUiBrowserSocket(h.socket);
  await closed;
  assert.equal(h.socket.listenerCount("error"), 0);
  assert.equal(h.socket.listenerCount("close"), 0);
});

test("CI04 navigation failure diagnostics distinguish headers, body and completed response", () => {
  let now = 100;
  const observed = createUiNavigationDiagnostic({ now: () => now });
  const url = "http://127.0.0.1:1234/admin/clients?private=secret";
  const event = (method, params, sessionId = "tab") => observed.observe({ method, params, sessionId });
  assert.equal(observed.diagnostic(), undefined);
  observed.begin(url, "en", "tab");
  event("Network.requestWillBeSent", { requestId: "other", request: { url } }, "other-tab");
  event("Network.requestWillBeSent", { requestId: "asset", request: { url: url + "-asset" } });
  assert.equal(observed.diagnostic().phase, "not_started");
  event("Network.requestWillBeSent", { requestId: "document", type: "Document", request: { url } });
  now = 300;
  assert.deepEqual(observed.diagnostic(), { locale: "en", phase: "headers_pending", status: null, elapsed_ms: 200, exception_count: 0,
    request_count: 1, request_type: "document", first_phase: "headers_pending", first_status: null, redirect_count: 0, navigation_error_count: 0 });
  event("Network.responseReceived", { requestId: "asset", response: { status: 404 } });
  assert.equal(observed.diagnostic().status, null);
  event("Network.responseReceived", { requestId: "document", response: { status: 200, headers: { Cookie: "private" } } });
  assert.equal(observed.diagnostic().phase, "body_pending");
  event("Network.loadingFinished", { requestId: "document" });
  event("Runtime.exceptionThrown", { exceptionDetails: { text: "private exception" } });
  const complete = observed.diagnostic();
  assert.deepEqual(complete, { locale: "en", phase: "complete", status: 200, elapsed_ms: 200, exception_count: 1,
    request_count: 1, request_type: "document", first_phase: "complete", first_status: 200, redirect_count: 0, navigation_error_count: 0 });
  assert.doesNotMatch(JSON.stringify(complete), /secret|private|Cookie|requestId|127\.0\.0\.1/);
});

test("CI04 navigation diagnostics reset between locales and follow the latest matching request", () => {
  let now = 0;
  const observed = createUiNavigationDiagnostic({ now: () => now });
  const url = "http://127.0.0.1:1234/admin/clients";
  const event = (method, params) => observed.observe({ method, params, sessionId: "tab" });
  observed.begin(url, "en", "tab");
  event("Network.requestWillBeSent", { requestId: "old", request: { url } });
  event("Runtime.exceptionThrown", {});
  now = 50;
  observed.begin(url, "zh-CN", "tab");
  event("Network.loadingFinished", { requestId: "old" });
  assert.deepEqual(observed.diagnostic(), { locale: "zh-CN", phase: "not_started", status: null, elapsed_ms: 0, exception_count: 0,
    request_count: 0, request_type: null, first_phase: "not_started", first_status: null, redirect_count: 0, navigation_error_count: 0 });
  event("Network.requestWillBeSent", { requestId: "fetch", type: "Fetch", request: { url } });
  event("Network.responseReceived", { requestId: "fetch", response: { status: 200 } });
  event("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "unrelated private error" }] });
  event("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "Runmesh navigation failed" }, { description: "private cause" }] });
  event("Network.requestWillBeSent", { requestId: "reload", type: "Document", request: { url } });
  event("Network.loadingFinished", { requestId: "fetch" });
  assert.equal(observed.diagnostic().phase, "headers_pending");
  event("Network.loadingFailed", { requestId: "reload", errorText: "private failure" });
  now = 900000;
  for (let i = 0; i < 1005; i++) event("Runtime.exceptionThrown", {});
  const diagnostic = observed.diagnostic();
  assert.deepEqual(diagnostic, { locale: "zh-CN", phase: "failed", status: null, elapsed_ms: 600000, exception_count: 1000,
    request_count: 2, request_type: "document", first_phase: "complete", first_status: 200, redirect_count: 0, navigation_error_count: 1 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|cause|requestId|127\.0\.0\.1/);
});

test("CI04 navigation diagnostics keep the first failed fetch while bounding replacement requests and caught errors", () => {
  const observed = createUiNavigationDiagnostic();
  const url = "http://127.0.0.1:1234/admin/clients";
  const event = (method, params) => observed.observe({ method, params, sessionId: "tab" });
  observed.begin(url, "en", "tab");
  event("Network.requestWillBeSent", { requestId: "first", type: "Fetch", request: { url } });
  event("Network.loadingFailed", { requestId: "first", canceled: true, errorText: "private" });
  for (let i = 0; i < 1005; i++) {
    event("Network.requestWillBeSent", { requestId: String(i), type: "private", request: { url } });
    event("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "Runmesh navigation failed" }, { value: "private" }] });
  }
  const diagnostic = observed.diagnostic();
  assert.equal(diagnostic.request_count, 1000); assert.equal(diagnostic.navigation_error_count, 1000);
  assert.equal(diagnostic.request_type, "other"); assert.equal(diagnostic.first_phase, "failed"); assert.equal(diagnostic.first_status, null);
  assert.equal(diagnostic.phase, "headers_pending"); assert.equal(diagnostic.exception_count, 0);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|canceled|requestId|127\.0\.0\.1/);
});

test("CI04 navigation diagnostics count redirect hops without inventing another request", () => {
  const observed = createUiNavigationDiagnostic({ now: () => 5000 });
  const url = "http://127.0.0.1:1234/admin/clients";
  const event = (method, params) => observed.observe({ method, params, sessionId: "tab" });
  observed.begin(url, "en", "tab");
  event("Network.requestWillBeSent", { requestId: "fetch", type: "Fetch", request: { url } });
  event("Network.requestWillBeSent", { requestId: "fetch", type: "Fetch", request: { url: "http://127.0.0.1:1234/" }, redirectResponse: { status: 303, headers: { Cookie: "private" } } });
  event("Network.requestWillBeSent", { requestId: "fetch", type: "Fetch", request: { url }, redirectResponse: { status: 302 } });
  assert.equal(observed.diagnostic().request_count, 1); assert.equal(observed.diagnostic().redirect_count, 2);
  event("Network.responseReceived", { requestId: "fetch", response: { status: 200 } });
  event("Network.loadingFinished", { requestId: "fetch" });
  assert.equal(observed.diagnostic().status, 200); assert.equal(observed.diagnostic().first_status, 303);
  event("Network.requestWillBeSent", { requestId: "fallback", type: "Document", request: { url } });
  const diagnostic = observed.diagnostic();
  assert.deepEqual(diagnostic, { locale: "en", phase: "headers_pending", status: null, elapsed_ms: 0, exception_count: 0,
    request_count: 2, request_type: "document", first_phase: "complete", first_status: 303, redirect_count: 2, navigation_error_count: 0 });
  const failure = withUiNavigationDiagnostic(new Error("Browser navigation readiness timed out after 5000 ms\nRUNMESH_E2E_UI_NAVIGATION_STATE=navigation_busy (stage: clients_navigation)"), diagnostic);
  const summary = browserFailureEvidence({ testResults: [{ assertionResults: [{ title: REQUIRED_BROWSER_TEST, status: "failed", failureMessages: [failure.message] }] }] });
  assert.equal(summary.required_browser_status, "failed"); assert.equal(summary.failures[0].kind, "browser_navigation_timeout");
  assert.deepEqual(summary.failures[0].navigation, diagnostic);
  assert.doesNotMatch(JSON.stringify(summary), /private|Cookie|127\.0\.0\.1/);
  for (let i = 0; i < 1005; i++) event("Network.requestWillBeSent", { requestId: "fallback", type: "Document", request: { url }, redirectResponse: { status: 302 } });
  assert.equal(observed.diagnostic().redirect_count, 1000); assert.equal(observed.diagnostic().request_count, 2);
});

test("CI04 navigation diagnostic parser projects fixed fields and rejects malformed observations", () => {
  const valid = { locale: "en", phase: "body_pending", status: 200, elapsed_ms: 5000, exception_count: 0 };
  assert.deepEqual(uiNavigationFailureDiagnostic(uiNavigationDiagnosticMarker({ ...valid, url: "private" })), valid);
  for (const changed of [{ locale: "private" }, { phase: "private" }, { status: 600 }, { status: "200" },
    { elapsed_ms: -1 }, { elapsed_ms: 600001 }, { elapsed_ms: 0.5 }, { exception_count: 1001 }]) {
    assert.equal(uiNavigationFailureDiagnostic(uiNavigationDiagnosticMarker({ ...valid, ...changed })), undefined);
  }
  assert.equal(uiNavigationFailureDiagnostic("RUNMESH_E2E_UI_NAVIGATION_DIAGNOSTIC={broken}"), undefined);
  const extended = { ...valid, request_count: 2, request_type: "document", first_phase: "complete", first_status: 200, redirect_count: 0, navigation_error_count: 1 };
  assert.deepEqual(uiNavigationFailureDiagnostic(uiNavigationDiagnosticMarker({ ...extended, url: "private" })), extended);
  for (const changed of [{ request_count: 1001 }, { request_count: -1 }, { request_count: 0.5 }, { request_type: "private" },
    { first_phase: "private" }, { first_status: 600 }, { first_status: "200" }, { redirect_count: 1001 }, { redirect_count: -1 }, { navigation_error_count: 1001 }, { first_phase: undefined }]) {
    assert.equal(uiNavigationFailureDiagnostic(uiNavigationDiagnosticMarker({ ...extended, ...changed })), undefined);
  }
});

test("CI04 timed-out navigation retains its network phase through browser failure evidence", async () => {
  const h = navigationFixture();
  const expected = { url: "http://127.0.0.1:1234/admin/clients", locale: "en" };
  const observed = createUiNavigationDiagnostic({ now: h.clock.now });
  observed.begin(expected.url, expected.locale, "tab");
  observed.observe({ method: "Network.requestWillBeSent", sessionId: "tab", params: { requestId: "private-id", type: "Fetch", request: { url: expected.url } } });
  h.state.loading = true;
  let failed;
  try { await waitForUiNavigation(h.tab, expected, { ...h.clock, stage: "clients_navigation" }); }
  catch (error) { failed = error; }
  assert.ok(failed);
  const wrapped = withUiNavigationDiagnostic(failed, observed.diagnostic());
  assert.equal(wrapped.cause, failed);
  const message = wrapped.message;
  const summary = browserFailureEvidence({ testResults: [{ assertionResults: [{ title: REQUIRED_BROWSER_TEST, status: "failed", failureMessages: [message] }] }] });
  assert.equal(summary.required_browser_status, "failed");
  assert.equal(summary.failures[0].navigation_state, "navigation_busy");
  assert.deepEqual(summary.failures[0].navigation, { locale: "en", phase: "headers_pending", status: null, elapsed_ms: 5000, exception_count: 0,
    request_count: 1, request_type: "fetch", first_phase: "headers_pending", first_status: null, redirect_count: 0, navigation_error_count: 0 });
  assert.doesNotMatch(JSON.stringify(summary), /private-id|127\.0\.0\.1/);
});

test("CI04 navigation diagnostic annotation preserves the original error classification", () => {
  let original;
  try { assert.equal("private actual", "private expected"); } catch (error) { original = error; }
  const diagnostic = { locale: "en", phase: "not_started", status: null, elapsed_ms: 10, exception_count: 0 };
  const wrapped = withUiNavigationDiagnostic(original, diagnostic);
  assert.equal(wrapped.name, original.name);
  assert.equal(wrapped.code, original.code);
  assert.equal(wrapped.cause, original);
  assert.equal(browserErrorDiagnostic(wrapped).kind, "assertion_failed");
  const summary = browserFailureEvidence({ testResults: [{ assertionResults: [{ title: REQUIRED_BROWSER_TEST, status: "failed", failureMessages: [wrapped.stack] }] }] });
  assert.equal(summary.failures[0].kind, "assertion_failed");
  assert.deepEqual(summary.failures[0].navigation, diagnostic);
  assert.doesNotMatch(JSON.stringify(summary), /private actual|private expected/);
});

test("CI04 full navigation waits beyond a ready old document for the requested loader and locale", async () => {
  const h = navigationFixture(), expected = { url: h.state.url, locale: h.state.locale, frameId: "main-frame", loaderId: "new-document" };
  Object.assign(h.state, { url: "http://127.0.0.1:1234/admin", locale: "en", loaderId: "old-document" });
  h.onPause = () => {
    if (h.polls === 1) Object.assign(h.state, { url: expected.url, locale: expected.locale });
    if (h.polls === 2) Object.assign(h.state, { loaderId: expected.loaderId, readyState: "loading" });
    if (h.polls === 3) h.state.readyState = "complete";
  };
  await waitForUiNavigation(h.tab, expected, h.clock);
  assert.equal(h.polls, 3);
  assert.deepEqual(h.evaluatedLoaders, ["new-document", "new-document", "new-document"]);
  assert.ok(h.budgets.every(budget => budget > 0 && budget <= 5000));
});

test("CI04 SPA and cookie reload readiness require the target locale and completed mounted navigation", async () => {
  const h = navigationFixture(), expected = { url: "http://127.0.0.1:1234/admin/clients", locale: "en" };
  h.state.url = expected.url;
  h.onPause = () => {
    if (h.polls === 1) Object.assign(h.state, { locale: "en", loaderId: "reloaded-document", initialized: false });
    if (h.polls === 2) Object.assign(h.state, { initialized: true, loading: true });
    if (h.polls === 3) h.state.loading = false;
  };
  await waitForUiNavigation(h.tab, expected, h.clock);
  assert.equal(h.polls, 3);
});

test("CI04 completed SPA navigation uses the actual DOM URL while frame metadata catches up", async () => {
  const h = navigationFixture(), expected = { url: "http://127.0.0.1:1234/admin/clients", locale: h.state.locale };
  h.state.frameUrl = h.state.url;
  h.state.url = expected.url;
  await waitForUiNavigation(h.tab, expected, { ...h.clock, stage: "clients_navigation" });
  assert.equal(h.polls, 0);
  assert.deepEqual(h.evaluatedLoaders, ["new-document", "new-document"]);
});

test("CI04 SPA frame metadata cannot certify an incorrect live DOM URL", async () => {
  const h = navigationFixture(), expected = { url: "http://127.0.0.1:1234/admin/clients", locale: h.state.locale };
  h.state.frameUrl = expected.url;
  await assert.rejects(waitForUiNavigation(h.tab, expected, { ...h.clock, stage: "clients_navigation" }), error => {
    assert.equal(browserErrorDiagnostic(error).navigation_state, "location_pending");
    return true;
  });
  assert.equal(h.elapsed, 5000);
});

test("CI04 SPA completion rechecks the live URL and busy flag after verifying the loader", async () => {
  for (const changed of [{ url: "http://127.0.0.1:1234/admin/clients" }, { loading: true }]) {
    const h = navigationFixture(), expected = { url: h.state.url, locale: h.state.locale }, read = h.tab;
    let frameReads = 0;
    const tab = async (...args) => {
      const result = await read(...args);
      if (args[0] === "Page.getFrameTree" && ++frameReads === 2) Object.assign(h.state, changed);
      return result;
    };
    await assert.rejects(waitForUiNavigation(tab, expected, { ...h.clock, stage: "clients_navigation" }), error => {
      assert.equal(browserErrorDiagnostic(error).navigation_state, changed.loading ? "navigation_busy" : "location_pending");
      return true;
    });
    assert.equal(h.elapsed, 5000);
  }
});

test("CI04 an unmet browser navigation deadline fails instead of inspecting the old page", async () => {
  const h = navigationFixture();
  await assert.rejects(waitForUiNavigation(h.tab, { url: h.state.url, locale: "en" }, h.clock), /navigation readiness timed out after 5000 ms/u);
  assert.equal(h.elapsed, 5000);
});

test("CI04 navigation timeout retains its stage and last unmet condition without private browser state", async () => {
  for (const [changed, condition] of [
    [{ url: "http://127.0.0.1:1234/private?token=secret" }, "location_pending"],
    [{ locale: "private-locale" }, "locale_pending"],
    [{ readyState: "loading" }, "document_pending"],
    [{ initialized: false }, "initialization_pending"],
    [{ loading: true }, "navigation_busy"],
  ]) {
    const h = navigationFixture(), expected = { url: h.state.url, locale: h.state.locale };
    Object.assign(h.state, changed);
    await assert.rejects(waitForUiNavigation(h.tab, expected, { ...h.clock, stage: "clients_navigation" }), error => {
      const diagnostic = browserErrorDiagnostic(error);
      assert.equal(diagnostic.kind, "browser_navigation_timeout");
      assert.equal(diagnostic.stage, "clients_navigation");
      assert.equal(diagnostic.navigation_state, condition);
      assert.doesNotMatch(error.message, /private|secret|127\.0\.0\.1/u);
      return true;
    });
    assert.equal(h.elapsed, 5000);
  }
});

test("CI04 navigation timeout distinguishes a changed frame from readiness returned after the deadline", async () => {
  for (const condition of ["frame_changed", "deadline_exhausted"]) {
    const h = navigationFixture(), expected = { url: h.state.url, locale: h.state.locale }, read = h.tab;
    let frameReads = 0;
    const tab = async (...args) => {
      const result = await read(...args);
      if (args[0] === "Page.getFrameTree" && ++frameReads % 2 === 0) {
        if (condition === "frame_changed") result.frameTree.frame.loaderId = "private-loader";
        else h.elapsed = 5000;
      }
      return result;
    };
    await assert.rejects(waitForUiNavigation(tab, expected, { ...h.clock, stage: "dashboard_return" }), error => {
      assert.equal(browserErrorDiagnostic(error).navigation_state, condition);
      assert.equal(browserErrorDiagnostic(error).stage, "dashboard_return");
      assert.doesNotMatch(error.message, /private/u);
      return true;
    });
    assert.equal(h.elapsed, 5000);
  }
});

test("CI04 context changes remain transient and report their condition only if navigation exhausts its budget", async () => {
  const h = navigationFixture(), expected = { url: h.state.url, locale: h.state.locale };
  const changed = () => { h.evaluateError = Object.assign(new Error("Execution context was destroyed."), { code: -32000 }); };
  changed(); h.onPause = changed;
  await assert.rejects(waitForUiNavigation(h.tab, expected, { ...h.clock, stage: "locale_navigation" }), error => {
    assert.equal(browserErrorDiagnostic(error).navigation_state, "context_changed");
    assert.equal(browserErrorDiagnostic(error).stage, "locale_navigation");
    return true;
  });
  assert.equal(h.elapsed, 5000); assert.equal(h.polls, 100);
});

test("CI04 only recognized destroyed-context CDP errors are retried during navigation", async () => {
  const h = navigationFixture(), expected = { url: h.state.url, locale: h.state.locale };
  h.evaluateError = Object.assign(new Error("Execution context was destroyed."), { code: -32000 });
  await waitForUiNavigation(h.tab, expected, h.clock);
  assert.equal(h.polls, 1);
  for (const error of [Object.assign(new Error("Permission denied"), { code: -32000 }),
    Object.assign(new Error("Execution context was destroyed."), { code: -32602 }), new Error("socket closed")]) {
    const failed = navigationFixture(); failed.evaluateError = error;
    await assert.rejects(waitForUiNavigation(failed.tab, expected, failed.clock), value => value === error);
    assert.equal(failed.polls, 0);
  }
});
