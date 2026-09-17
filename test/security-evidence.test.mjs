import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { securityTestFiles, projectSecurityEvidence } from "../scripts/security-regressions.mjs";
const root = resolve("/synthetic-runmesh"), file = "apps/worker/test/release-admin-security.test.ts", commit = "a".repeat(40);
function fixture() {
  return {
    manifest: { schema_version: 1, findings: Array.from({ length: 10 }, (_, n) => ({ id: `SEC${String(n + 1).padStart(2, "0")}`, regressions: [file] })) },
    reports: [{ success: true, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTests: 1, numPassedTests: 1,
      testResults: [{ name: join(root, file), status: "passed", assertionResults: [{ fullName: "synthetic security assertion", status: "passed", failureMessages: [] }] }] }],
  };
}
test("security evidence binds reviewed findings to candidate assertions", () => {
  const f = fixture(), report = projectSecurityEvidence(f.manifest, commit, f.reports, root);
  assert.equal(report.commit, commit); assert.equal(report.findings.length, 10);
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
  "nonempty failure payload": f => f.reports[0].testResults[0].assertionResults[0].failureMessages = ["failure"],
})) test(`security evidence refuses ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => projectSecurityEvidence(f.manifest, commit, f.reports, root)); });
test("security evidence cannot invent an untested second file", () => {
  const f = fixture(); f.manifest.findings[0].regressions.push("apps/runner/test/release-boundary-security.test.ts");
  assert.equal(securityTestFiles(f.manifest).length, 2);
  assert.throws(() => projectSecurityEvidence(f.manifest, commit, f.reports, root));
});
