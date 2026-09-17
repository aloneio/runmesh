import assert from "node:assert/strict";
import { isAbsolute, relative, resolve, sep } from "node:path";

const regressionPath = /^apps\/(runner|worker)\/test\/[A-Za-z0-9._/-]+\.test\.ts$/u;
export function securityTestFiles(manifest) {
  assert.equal(manifest?.schema_version, 1);
  assert.ok(Array.isArray(manifest.findings) && manifest.findings.length >= 10 && manifest.findings.length <= 64);
  const ids = new Set(), files = new Set();
  for (const finding of manifest.findings) {
    assert.match(finding.id, /^SEC[0-9]{2}$/u); assert.ok(!ids.has(finding.id)); ids.add(finding.id);
    assert.ok(Array.isArray(finding.regressions) && finding.regressions.length > 0);
    for (const file of finding.regressions) {
      assert.equal(typeof file, "string"); assert.match(file, regressionPath);
      assert.ok(!file.split("/").includes("..")); files.add(file);
    }
  }
  for (let n = 1; n <= 10; n++) assert.ok(ids.has(`SEC${String(n).padStart(2, "0")}`));
  return [...files].sort();
}

/** Actual Vitest assertions, never a process exit re-labelled as test counts. */
export function projectSecurityEvidence(manifest, commit, reports, root) {
  assert.match(commit, /^[a-f0-9]{40}$/u);
  const expected = securityTestFiles(manifest), observed = new Map();
  assert.ok(Array.isArray(reports) && reports.length > 0 && reports.length <= 2);
  for (const report of reports) {
    assert.equal(report?.success, true); assert.equal(report.numFailedTests, 0);
    assert.equal(report.numPendingTests, 0); assert.equal(report.numTodoTests, 0);
    assert.ok(Array.isArray(report.testResults) && report.testResults.length > 0);
    let total = 0;
    for (const suite of report.testResults) {
      assert.equal(suite.status, "passed"); assert.ok(isAbsolute(suite.name));
      const file = relative(resolve(root), resolve(suite.name)).split(sep).join("/");
      assert.ok(expected.includes(file) && !observed.has(file), "unexpected or duplicate security suite");
      assert.ok(Array.isArray(suite.assertionResults) && suite.assertionResults.length > 0);
      const names = new Set();
      for (const test of suite.assertionResults) {
        assert.equal(test.status, "passed", "failed, skipped or pending security assertion");
        assert.ok(typeof test.fullName === "string" && test.fullName.length > 0 && !names.has(test.fullName)); names.add(test.fullName);
        assert.deepEqual(test.failureMessages, []);
      }
      observed.set(file, suite.assertionResults.length); total += suite.assertionResults.length;
    }
    assert.equal(report.numTotalTests, total); assert.equal(report.numPassedTests, total);
  }
  assert.deepEqual([...observed.keys()].sort(), expected, "missing security regression suite");
  return { schema_version: 1, commit, attestation: "self_reported", runtime: { platform: process.platform, node: process.version },
    findings: manifest.findings.map(finding => ({ id: finding.id, state: "passed", passed: finding.regressions.reduce((sum, file) => sum + observed.get(file), 0), failed: 0, skipped: 0, files: [...finding.regressions] })) };
}
