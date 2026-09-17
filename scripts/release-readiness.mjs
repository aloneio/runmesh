import assert from "node:assert/strict";

export const REQUIRED_SECURITY_FINDINGS = Object.freeze(Array.from({ length: 16 }, (_, index) => `SEC${String(index + 1).padStart(2, "0")}`));

/** CI configuration alone must not silently mark known security incidents as
 * fixed. Closure requires reviewed source-linked regression evidence. */
export function assertSecurityReadiness(manifest, currentSource, verification) {
  assert.equal(manifest?.schema_version, 1);
  assert.match(currentSource, /^[a-f0-9]{40}$/u);
  assert.ok(Array.isArray(manifest.findings) && manifest.findings.length >= REQUIRED_SECURITY_FINDINGS.length && manifest.findings.length <= 64);
  assert.equal(verification?.schema_version, 1);
  assert.equal(verification.commit, currentSource, "runtime evidence must identify this candidate");
  assert.ok(Array.isArray(verification.findings) && verification.findings.length === manifest.findings.length);
  const ids = new Set();
  for (const finding of manifest.findings) {
    assert.match(finding.id, /^SEC[0-9]{2}$/u); assert.ok(!ids.has(finding.id)); ids.add(finding.id);
    assert.equal(finding.state, "closed", `${finding.id} remains a release blocker`);
    assert.match(finding.fixed_commit ?? "", /^[a-f0-9]{40}$/u);
    assert.ok(Array.isArray(finding.regressions) && finding.regressions.length > 0);
    for (const test of finding.regressions) {
      assert.match(test, /^(?:apps\/(?:runner|worker)\/test|test\/e2e)\/[A-Za-z0-9._/-]+\.test\.[cm]?[jt]s$/u);
      assert.ok(!test.split("/").includes(".."));
    }
    // The candidate SHA belongs in runtime evidence, never inside its own
    // tracked manifest (which would create an impossible self-reference).
    const evidence = verification.findings.filter(value => value.id === finding.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].state, "passed");
    assert.ok(Number.isSafeInteger(evidence[0].passed) && evidence[0].passed > 0);
    assert.equal(evidence[0].failed, 0); assert.equal(evidence[0].skipped, 0);
    assert.deepEqual(evidence[0].files, finding.regressions);
  }
  for (const id of REQUIRED_SECURITY_FINDINGS) assert.ok(ids.has(id), `${id} is missing from security closure`);
  return { security_readiness: "verified", findings: ids.size, commit: currentSource };
}
