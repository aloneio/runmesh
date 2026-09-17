import assert from "node:assert/strict";
import { stringify } from "yaml";
import { parseCi, validateCiWiring } from "./ci-policy.mjs";
import { CI_CHECKS, CHECK_IDS, AGGREGATE_JOBS, UPLOAD_ACTION, checkCommand, GITLAB_EVENTS } from "./ci-contract.mjs";

const yaml = value => stringify(value, { aliasDuplicateObjects: false, lineWidth: 0 });
const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const node = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const rules = () => [...GITLAB_EVENTS.map(expression => ({ if: expression })), { when: "never" }];
const setup = () => [{ uses: checkout, with: { "persist-credentials": false } }, { uses: node, with: { "node-version-file": ".node-version", cache: "npm" } }, { run: "npm install --global npm@10.9.3" }];
const upload = name => ({ name: "Preserve sanitized gate evidence", if: "always()", uses: UPLOAD_ACTION, with: {
  name, path: "ci-results/*.json\nci-results/*.xml\n", "if-no-files-found": "error", "retention-days": 14, "include-hidden-files": false, overwrite: false, archive: true,
} });
const artifacts = () => ({ when: "always", expire_in: "14 days", paths: ["ci-results/*.json", "ci-results/*.xml"], reports: { junit: "ci-results/*.xml" } });

/** Pure candidate transformation. Returns proposed source texts and validates
 * their execution graph. It does not write files, install packages, weaken
 * branch policy, push, merge, sign, or deploy. Apply only against its baseline. */
export function proposedCiFiles(input) {
  const gh = parseCi(input.github), prefix = input.gitlab.split("# BEGIN GENERATED MAIN SOURCE POLICY")[0];
  const policy = input.gitlab.slice(prefix.length);
  assert.ok(policy.startsWith("# BEGIN GENERATED MAIN SOURCE POLICY"), "preserve the reviewed main-policy overlay");
  const gl = parseCi(prefix), pkg = structuredClone(input.pkg), plan = structuredClone(input.plan);
  // Independent npm dev dependencies are explicit; the lockfile must be
  // regenerated and audited by the authorized dependency installation step.
  pkg.devDependencies.yaml = "2.9.1";
  pkg.devDependencies.playwright = "1.63.0";
  pkg.scripts["test:browser"] = "node scripts/run-browser-e2e.mjs";
  pkg.scripts["test:security"] = "node scripts/run-security-regressions.mjs && node scripts/check-release-readiness.mjs";
  pkg.scripts["browser:install"] = "node node_modules/playwright/cli.js install --with-deps chromium";
  const tests = ["test/ci-remediation.test.mjs", "test/crossforge-readiness.test.mjs", "test/ci-layout.test.mjs"];
  for (const file of tests) {
    if (!pkg.scripts["test:release-tools"].includes(file)) pkg.scripts["test:release-tools"] += ` ./${file}`;
    const group = plan.groups.find(g => g.id === "tooling"); if (!group.files.includes(file)) group.files.push(file);
  }
  gh.on.workflow_call = { inputs: { release_verification: { description: "Keep this release's exact-source verification independent of newer pushes", type: "boolean", default: false } } };
  gh.concurrency = { group: "ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}-${{ (inputs.release_verification || github.event_name == 'workflow_dispatch') && github.run_id || 'ordinary' }}", "cancel-in-progress": "${{ !inputs.release_verification && github.event_name != 'workflow_dispatch' }}" };
  gh.jobs.verify["timeout-minutes"] = 30;
  const existing = gh.jobs.verify.steps;
  // Non-critical setup stays as reviewed; each former command maps exactly
  // once to the new wrapper, rather than growing a second execution list.
  for (const [id, command] of Object.entries(CI_CHECKS)) {
    // The historical input predates this new gate; insert it explicitly below.
    if (id === "security") continue;
    const matches = existing.filter(step => step.run === command);
    assert.equal(matches.length, 1, `baseline critical command drifted: ${command}`);
    matches[0].run = checkCommand(id);
  }
  const unitIndex = existing.findIndex(step => step.run === checkCommand("unit"));
  assert.ok(unitIndex >= 0, "legacy unit gate is required");
  existing.splice(unitIndex + 1, 0, { run: checkCommand("security") });
  // The old parity entrypoint now consumes the shared parsed CI contract.
  // It remains an ordinary explicit step; it is not self-granted permission.
  gh.jobs.verify.steps.push(upload("ci-verify-${{ github.run_id }}-${{ github.run_attempt }}"));
  gh.jobs.browser = { "runs-on": "ubuntu-latest", "timeout-minutes": 15, steps: [...setup(),
    { run: "npm ci" }, { run: "npm run typecheck" }, { run: "npm run build" }, { run: "npm run browser:install" }, { run: "npm run test:browser" },
    upload("ci-browser-${{ github.run_id }}-${{ github.run_attempt }}"),
  ] };
  const env = Object.fromEntries(AGGREGATE_JOBS.map(name => [name.replaceAll("-", "_").toUpperCase(), `\${{ needs.${name}.result }}`]));
  gh.jobs["verify-all"].needs = [...AGGREGATE_JOBS];
  gh.jobs["verify-all"].steps = [{ name: "Require every mandatory job", env, run: Object.keys(env).map(key => `test "$${key}" = success`).join(" && ") }];
  gl.workflow.rules = rules();
  Object.assign(gl.verify, { timeout: "30m", interruptible: true, allow_failure: false, rules: rules(),
    script: ["npm install --global npm@10.9.3", ...CHECK_IDS.map(checkCommand)], artifacts: artifacts() });
  gl.browser = { stage: "verify", timeout: "15m", interruptible: true, allow_failure: false, rules: rules(),
    script: ["npm install --global npm@10.9.3", "npm ci", "npm run typecheck", "npm run build", "npm run browser:install", "npm run test:browser"], artifacts: artifacts() };
  const github = yaml(gh), gitlab = yaml(gl) + "\n" + policy;
  validateCiWiring(pkg, github, gitlab);
  const cli = `import { readFile } from "node:fs/promises";\nimport { validateCiWiring } from "./ci-policy.mjs";\nconst root = new URL("../", import.meta.url);\nconst read = path => readFile(new URL(path, root), "utf8");\ntry { console.log(JSON.stringify(validateCiWiring(JSON.parse(await read("package.json")), await read(".github/workflows/ci.yml"), await read(".gitlab-ci.yml")))); }\ncatch (error) { console.error("CI execution contract failed:", error.message); process.exitCode = 1; }\n`;
  const files = {
    ".github/workflows/ci.yml": github, ".gitlab-ci.yml": gitlab,
    "package.json": JSON.stringify(pkg, null, 2) + "\n", "test/verification-plan.json": JSON.stringify(plan, null, 2) + "\n",
    "scripts/check-ci-parity.mjs": cli,
    ".github/dependabot.yml": yaml({ version: 2, updates: [
      { "package-ecosystem": "npm", directory: "/", "target-branch": "dev", schedule: { interval: "weekly" }, "open-pull-requests-limit": 5 },
      { "package-ecosystem": "github-actions", directory: "/", "target-branch": "dev", schedule: { interval: "weekly" }, "open-pull-requests-limit": 5 },
    ] }),
    ".github/workflows/dependency-watch.yml": yaml({ name: "Dependency watch", on: { schedule: [{ cron: "17 2 * * 1" }], workflow_dispatch: null }, permissions: { contents: "read" },
      concurrency: { group: "dependency-watch", "cancel-in-progress": true }, jobs: { dependencies: { "runs-on": "ubuntu-latest", "timeout-minutes": 10,
        steps: [...setup(), { run: "npm ci --ignore-scripts" }, { run: "npm audit --audit-level=high" }, { run: "npm audit --omit=dev --audit-level=high" }] } } }),
  };
  if (input.verificationSource) {
    let s = input.verificationSource;
    const start = s.indexOf("  for (const config of [github, gitlab]) {");
    const end = s.indexOf("\n}\n", start);
    assert.ok(start >= 0 && end > start, "verification wiring baseline changed");
    s = s.slice(0, start) + "  validateCiWiring(pkg, github, gitlab);" + s.slice(end);
    files["scripts/verification-plan.mjs"] = 'import { validateCiWiring } from "./ci-policy.mjs";\n' + s;
  }
  if (input.browserSource) {
    assert.ok(input.browserSource.includes('spawn("/usr/bin/chromium",'));
    files["scripts/ui-browser-check.mjs"] = input.browserSource.replace('spawn("/usr/bin/chromium",', 'spawn(process.env.RUNMESH_CHROMIUM_EXECUTABLE ?? "/usr/bin/chromium",').replace("tail+=chunk;const match=", "tail=(tail+chunk).slice(-16384);const match=");
  }
  if (input.ignore) files[".gitignore"] = input.ignore + "\n# Sanitized CI observations are output, never build input.\n/ci-results/\n";
  if (input.verificationTests) {
    let source = input.verificationTests;
    const oldMutation = 'github.replaceAll("- run: npm run test:package:e2e", "# npm run test:package:e2e")';
    assert.ok(source.includes(oldMutation), "legacy wiring regression seam changed");
    source = source.replace(oldMutation, 'github.replaceAll("- run: node scripts/ci-check.mjs installed_transport", "# removed installed transport")');
    const start = source.indexOf('  for (const path of [".github/workflows/ci.yml", ".gitlab-ci.yml", "scripts/check-ci-parity.mjs"]) {');
    const end = source.indexOf('\n  const pkg =', start);
    assert.ok(start >= 0 && end > start, "legacy command-presence test changed");
    source = source.slice(0, start) + '  for (const command of ["npm run check:verification", "npm run test:package:e2e"]) assert.ok(Object.values(CI_CHECKS).includes(command));' + source.slice(end);
    files["test/verification-tools.test.mjs"] = 'import { CI_CHECKS } from "../scripts/ci-contract.mjs";\n' + source;
  }
  if (input.release) {
    assert.ok(input.release.includes("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"));
    let release = input.release.replace("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2", `${UPLOAD_ACTION} # v7.0.1`);
    const seam = "      - name: Sign and verify manifest and local release assets";
    assert.ok(release.includes(seam));
    release = release.replace(seam, `      - name: Execute reviewed security regressions for the exact candidate\n        run: node scripts/run-security-regressions.mjs\n      - name: Require reviewed security regression evidence\n        run: node scripts/check-release-readiness.mjs\n      - name: Require both providers at the exact protected main commit\n        env:\n          GH_TOKEN: \${{ github.token }}\n          GITLAB_READ_API_TOKEN: \${{ secrets.GITLAB_READ_API_TOKEN }}\n        run: node scripts/check-crossforge-ci.mjs\n${seam}`);
    files[".github/workflows/release.yml"] = release;
  }
  // These files own generated main-branch admission. Add only schedule
  // admission; retain the other agent's exact body, rules and source checks.
  for (const [path, source] of Object.entries(input.promotion ?? {})) {
    const needle = `    - if: '$CI_PIPELINE_SOURCE == "web"'\n    - when: never`;
    assert.ok(source.includes(needle), "promotion schedule seam changed");
    files[path] = source.replace(needle, `    - if: '$CI_PIPELINE_SOURCE == "web"'\n    - if: '$CI_PIPELINE_SOURCE == "schedule"'\n    - when: never`);
  }
  return { files, prerequisites: ["regenerate package-lock.json using approved dependency installation", "reconcile any parallel main-policy changes", "regenerate documentation facts for the updated test manifest", "run every full test and hosted platform job", "resolve security-release blockers separately", "main promotion and deployment require their own approval"], checks: CHECK_IDS.length };
}
