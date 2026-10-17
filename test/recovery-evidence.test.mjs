import assert from "node:assert/strict";
import { test } from "node:test";
import { RECOVERY_COMPONENTS, RECOVERY_CHECKS, validateRecoveryEvidence } from "../scripts/check-recovery-evidence.mjs";

const commit = "a".repeat(40);
function evidence() {
  const passed = () => ({ status: "passed", evidence_ref: "synthetic:fixture" });
  return { schema_version: 1, source: { commit, tree: "b".repeat(40), artifact_sha256: "c".repeat(64) }, environment: "isolated", credential_strategy: "preserve",
    key_version_refs: { internal_control: "vault:synthetic-control:v1", runner_pepper: "vault:synthetic-pepper:v1" },
    components: Object.fromEntries(RECOVERY_COMPONENTS.map(name => [name, { ...passed(), source_identity: name, target_identity: name, restore_point: "synthetic:point" }])),
    checks: Object.fromEntries([...RECOVERY_CHECKS, "fresh_credentials", "old_credentials_rejected"].map(name => [name, passed()])),
  };
}

test("accepts a complete same-commit record without emitting sensitive references", () => {
  const record = evidence(), result = validateRecoveryEvidence(record, commit);
  assert.deepEqual(result, { schema_version: 1, commit, ready: true, unmet: [] });
  assert.ok(!JSON.stringify(result).includes("vault:"));
});
for (const status of ["failed", "not_run", "unsupported"]) test(`does not promote ${status} PITR into successful local acceptance`, () => {
  const record = evidence(); record.checks.remote_pitr.status = status;
  assert.deepEqual(validateRecoveryEvidence(record, commit).unmet, ["checks.remote_pitr"]);
});
test("rejects missing revocation or policy reconciliation and a mismatched source", () => {
  const record = evidence();
  record.checks.latest_revocations.status = "not_run";
  record.checks.latest_permissions.evidence_ref = null;
  assert.deepEqual(validateRecoveryEvidence(record, "d".repeat(40)).unmet, ["source.commit", "checks.latest_revocations", "checks.latest_permissions"]);
});
test("same-key recovery is not enough when the encrypted identity changes", () => {
  const record = evidence(); record.components.capabilities.target_identity = "another-instance";
  assert.deepEqual(validateRecoveryEvidence(record, commit).unmet, ["components.capabilities.identity"]);
  record.credential_strategy = "reauthorize"; record.checks.fresh_credentials.status = "not_run";
  assert.deepEqual(validateRecoveryEvidence(record, commit).unmet, ["checks.fresh_credentials"]);
});
test("never accepts absent records, raw secret fields, or a production test target", () => {
  assert.throws(() => validateRecoveryEvidence(null, commit));
  const secret = evidence(); secret.key_version_refs.raw_secret = "do-not-emit";
  assert.throws(() => validateRecoveryEvidence(secret, commit));
  const production = evidence(); production.environment = "production";
  assert.throws(() => validateRecoveryEvidence(production, commit));
  const unknown = evidence(); unknown.checks.no_job_replay.status = "assumed";
  assert.throws(() => validateRecoveryEvidence(unknown, commit));
});
