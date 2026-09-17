import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { securityTestFiles, projectSecurityEvidence } from "../scripts/security-regressions.mjs";
import { REQUIRED_SECURITY_FINDINGS } from "../scripts/release-readiness.mjs";
const root = resolve("/synthetic-runmesh"), file = "apps/worker/test/release-admin-security.test.ts", commit = "a".repeat(40);
function fixture() {
  return {
    manifest: { schema_version: 1, findings: REQUIRED_SECURITY_FINDINGS.map(id => ({ id, regressions: [file] })) },
    reports: [{ success: true, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTests: 1, numPassedTests: 1,
      testResults: [{ name: join(root, file), status: "passed", assertionResults: [{ fullName: "synthetic security assertion", status: "passed", failureMessages: [] }] }] }],
  };
}
test("security evidence binds reviewed findings to candidate assertions", () => {
  const f = fixture(), report = projectSecurityEvidence(f.manifest, commit, f.reports, root);
  assert.equal(report.commit, commit); assert.equal(report.findings.length, REQUIRED_SECURITY_FINDINGS.length);
  assert.deepEqual(report.findings[0], { id: "SEC01", state: "passed", passed: 1, failed: 0, skipped: 0, files: [file] });
});
for (const [name, mutate] of Object.entries({
  "unsuccessful process": f => f.reports[0].success = false,
  "failed suite": f => f.reports[0].testResults[0].status = "failed",
  "failed assertion": f => f.reports[0].testResults[0].assertionResults[0].status = "failed",
  "skipped assertion": f => f.reports[0].testResults[0].assertionResults[0].status = "pending",
  "pending total": f => f.reports[0].numPendingTests = 1,
  "todo total": f => f.reports[0].numTodoTests = 1,
  "fabricated count": f => f.reports[0].numPassedTests = 20,
  "missing assertions": f => f.reports[0].testResults[0].assertionResults = [],
  "missing suite": f => f.reports[0].testResults = [],
  "duplicate suite": f => f.reports.push(structuredClone(f.reports[0])),
  "unowned suite": f => f.reports[0].testResults[0].name = join(root, "apps/worker/test/unrelated.test.ts"),
  "external suite": f => f.reports[0].testResults[0].name = resolve(root, "../private.test.ts"),
  "duplicate finding": f => f.manifest.findings[1].id = "SEC01",
  "unsafe regression path": f => f.manifest.findings[0].regressions = ["apps/worker/test/../../private.test.ts"],
  "missing mandatory finding": f => f.manifest.findings.pop(),
  "replacement for deadline finding": f => f.manifest.findings[10].id = "SEC99",
  "replacement for completion receipt finding": f => f.manifest.findings[11].id = "SEC99",
  "replacement for selection identity finding": f => f.manifest.findings[12].id = "SEC99",
  "replacement for final admission finding": f => f.manifest.findings[13].id = "SEC99",
  "replacement for bounded observation finding": f => f.manifest.findings[14].id = "SEC99",
  "replacement for Job snapshot identity finding": f => f.manifest.findings[15].id = "SEC99",
  "replacement for special-file boundary finding": f => f.manifest.findings[16].id = "SEC99",
  "replacement for remaining metadata finding": f => f.manifest.findings[17].id = "SEC99",
  "nonempty failure payload": f => f.reports[0].testResults[0].assertionResults[0].failureMessages = ["failure"],
})) test(`security evidence refuses ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => projectSecurityEvidence(f.manifest, commit, f.reports, root)); });
test("security evidence cannot invent an untested second file", () => {
  const f = fixture(); f.manifest.findings[0].regressions.push("apps/runner/test/release-boundary-security.test.ts");
  assert.equal(securityTestFiles(f.manifest).length, 2);
  assert.throws(() => projectSecurityEvidence(f.manifest, commit, f.reports, root));
});

test("the tracked security manifest retains reauthorization deadline coverage", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(new URL("../release/security-readiness.json", import.meta.url), "utf8"));
  const finding = manifest.findings.find(value => value.id === "SEC11");
  assert.equal(finding?.state, "closed");
  assert.deepEqual(finding.regressions, ["apps/worker/test/reauthorization-budget.test.ts"]);
  assert.ok(securityTestFiles(manifest).includes(finding.regressions[0]));
});

test("the tracked security manifest retains completion and selection identity coverage", async () => {
  const { readFile } = await import("node:fs/promises");
  const { REQUIRED_SECURITY_FINDINGS } = await import("../scripts/release-readiness.mjs");
  const manifest = JSON.parse(await readFile(new URL("../release/security-readiness.json", import.meta.url), "utf8"));
  for (const id of ["SEC12", "SEC13"]) {
    assert.ok(REQUIRED_SECURITY_FINDINGS.includes(id));
    const finding = manifest.findings.find(value => value.id === id);
    assert.equal(finding?.state, "closed");
    assert.deepEqual(finding.regressions, ["apps/worker/test/mcp-failure-chain.test.ts"]);
    assert.ok(securityTestFiles(manifest).includes(finding.regressions[0]));
  }
});

test("candidate security gates retain ancestry and cannot reuse old evidence", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parseCi } = await import("../scripts/ci-policy.mjs");
  const read = file => readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const gh = parseCi(await read(".github/workflows/ci.yml")), gl = parseCi(await read(".gitlab-ci.yml"));
  const checkout = gh.jobs.verify.steps.filter(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.length, 1); assert.equal(checkout[0].with["fetch-depth"], 0);
  assert.equal(checkout[0].if, undefined); assert.equal(gl.verify.variables.GIT_DEPTH, "0");
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.scripts["test:security"], "node scripts/run-security-regressions.mjs && node scripts/check-release-readiness.mjs");
  const release = parseCi(await read(".github/workflows/release.yml")).jobs.release.steps;
  const execute = release.findIndex(step => step.run === "node scripts/run-security-regressions.mjs");
  const verify = release.findIndex(step => step.run === "node scripts/check-release-readiness.mjs");
  const sign = release.findIndex(step => step.name === "Sign and verify manifest and local release assets");
  assert.ok(execute >= 0 && execute < verify && verify < sign);
  assert.equal(release[execute].if, undefined); assert.equal(release[execute]["continue-on-error"], undefined);
});


test("the tracked manifest requires final admission, bounded observations and Job snapshot identity", async () => {
  const { readFile } = await import("node:fs/promises");
  const { REQUIRED_SECURITY_FINDINGS } = await import("../scripts/release-readiness.mjs");
  const manifest = JSON.parse(await readFile(new URL("../release/security-readiness.json", import.meta.url), "utf8"));
  const expected = {
    SEC14: ["apps/worker/test/bridge-admission-errors.test.ts", "apps/worker/test/queue-grant.test.ts"],
    SEC15: ["apps/worker/test/mcp-failure-chain.test.ts", "apps/worker/test/release-admin-security.test.ts"],
    SEC16: ["apps/worker/test/mcp-failure-chain.test.ts"],
  };
  for (const [id, files] of Object.entries(expected)) {
    assert.ok(REQUIRED_SECURITY_FINDINGS.includes(id));
    const finding = manifest.findings.find(value => value.id === id);
    assert.equal(finding?.state, "closed");
    assert.deepEqual(finding.regressions, files);
    for (const file of files) assert.ok(securityTestFiles(manifest).includes(file));
  }
});


test("the tracked manifest requires Runner special-file, metadata and directory boundary coverage", async () => {
  const { readFile } = await import("node:fs/promises");
  const { REQUIRED_SECURITY_FINDINGS } = await import("../scripts/release-readiness.mjs");
  const manifest = JSON.parse(await readFile(new URL("../release/security-readiness.json", import.meta.url), "utf8"));
  for (const id of ["SEC17", "SEC18"]) {
    assert.ok(REQUIRED_SECURITY_FINDINGS.includes(id));
    const finding = manifest.findings.find(value => value.id === id);
    assert.equal(finding?.state, "closed");
    assert.deepEqual(finding.regressions, ["apps/runner/test/release-boundary-security.test.ts"]);
    assert.ok(securityTestFiles(manifest).includes(finding.regressions[0]));
  }
});
