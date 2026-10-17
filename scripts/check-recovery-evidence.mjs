import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const RECOVERY_COMPONENTS = Object.freeze(["registry", "runner_do", "capabilities", "d1", "runner_local"]);
export const RECOVERY_CHECKS = Object.freeze(["coordinated_restore_points", "same_identity_credentials", "cross_identity_rejection", "latest_revocations", "latest_permissions", "job_results", "no_job_replay", "runner_connection", "external_oauth", "rollback", "remote_pitr"]);
const invalid = () => { throw new Error("Invalid recovery evidence; use the data-recovery runbook schema."); };
const object = (value, keys) => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid();
};
const reference = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value);

/** Offline evidence validation, not platform attestation or authorization.
 * Never restores data, grants permissions, or replays work. Output omits IDs,
 * recovery points and secret-version references even when validation fails. */
export function validateRecoveryEvidence(report, expectedCommit) {
  object(report, ["schema_version", "source", "environment", "credential_strategy", "key_version_refs", "components", "checks"]);
  if (report.schema_version !== 1 || report.environment !== "isolated" || !["preserve", "reauthorize"].includes(report.credential_strategy)) invalid();
  object(report.source, ["commit", "tree", "artifact_sha256"]);
  if (![report.source.commit, report.source.tree, expectedCommit].every(value => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value))
    || typeof report.source.artifact_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(report.source.artifact_sha256)) invalid();
  object(report.key_version_refs, ["internal_control", "runner_pepper"]);
  if (!Object.values(report.key_version_refs).every(reference)) invalid();
  object(report.components, RECOVERY_COMPONENTS);
  object(report.checks, [...RECOVERY_CHECKS, "fresh_credentials", "old_credentials_rejected"]);
  const unmet = report.source.commit === expectedCommit ? [] : ["source.commit"];
  const observation = (item, label, keys) => {
    object(item, keys);
    if (!["passed", "failed", "not_run", "unsupported"].includes(item.status) || (item.evidence_ref !== null && !reference(item.evidence_ref))) invalid();
    if (item.status !== "passed" || item.evidence_ref === null) unmet.push(label);
  };
  for (const name of RECOVERY_COMPONENTS) {
    const item = report.components[name];
    observation(item, `components.${name}`, ["status", "evidence_ref", "source_identity", "target_identity", "restore_point"]);
    if (![item.source_identity, item.target_identity, item.restore_point].every(reference)) invalid();
    if (report.credential_strategy === "preserve" && ["registry", "runner_do", "capabilities"].includes(name) && item.source_identity !== item.target_identity)
      unmet.push(`components.${name}.identity`);
  }
  for (const name of [...RECOVERY_CHECKS, "fresh_credentials", "old_credentials_rejected"]) {
    if (report.credential_strategy === "preserve" && ["fresh_credentials", "old_credentials_rejected"].includes(name)) {
      // Still validate the shape; these migration-only checks may be not_run.
      const item = report.checks[name];
      object(item, ["status", "evidence_ref"]);
      if (!["passed", "failed", "not_run", "unsupported"].includes(item.status) || (item.evidence_ref !== null && !reference(item.evidence_ref))) invalid();
    } else observation(report.checks[name], `checks.${name}`, ["status", "evidence_ref"]);
  }
  return { schema_version: 1, commit: report.source.commit, ready: unmet.length === 0, unmet };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: node scripts/check-recovery-evidence.mjs FILE EXPECTED_COMMIT");
    const file = process.argv[2];
    if ((await stat(file)).size > 1024 * 1024) invalid();
    const result = validateRecoveryEvidence(JSON.parse(await readFile(file, "utf8")), process.argv[3]);
    console.log(JSON.stringify(result));
    if (!result.ready) process.exitCode = 1;
  } catch {
    console.error("recovery_evidence_invalid: supply a bounded runbook record and the expected commit; no recovery was performed");
    process.exitCode = 2;
  }
}
