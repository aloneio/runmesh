# Data and credential recovery

[简体中文](data-recovery.zh-CN.md) · [Upgrade guide](upgrading.md) · [Verification](verification.md)

Recovery is an operator procedure, not permission to replay Jobs or replace identities. Rehearse with synthetic data in an isolated deployment. Keep plans, exports, recovery points and evidence outside Git. This guide adds no public repair API or automatic restore service.

## History isolation and retention

D1 history is optional, not an authorization source. A damaged snapshot fails explicitly while healthy Runner history remains readable. Input rejection and exhausted revision conflicts stay local. Only failed D1 operations open the dependency circuit. Live workspace-bound Job queries retain their existing authorization checks.

Cleanup examines at most 20 snapshots per invocation. Invalid JSON, invalid Job metadata, duplicate/mismatched identities and oversized payloads are marked in the original row using `corrupt_revision`, `corrupt_detected_at_ms` and `corrupt_reason`. No second body copy is made. Repeated visits do not extend the first detection time. Snapshot revision CAS protects quarantine and deletion. A failed D1 write stops the sweep without committing its cursor.

The diagnostic body becomes eligible for removal after `min(retention_days, 7)` days from detection; invalid retention metadata uses seven days. Removal leaves an explicitly unavailable tombstone, **not** an empty successful history. Current-lifecycle tombstones remain until operator repair; authoritatively retired lifecycles follow their normal retention. For a retired row with malformed retention metadata, a trusted retirement timestamp, a full seven-day quarantine period, and seven days after retirement are required before reclaiming its empty expired tombstone. Untrusted retirement timestamps require operator reconciliation. Outages and scan backlog can delay physical removal. Any separate forensic export needs its own access control and finite retention.

A cleanup receipt's `complete` means the bounded sweep completed, not that every stored snapshot is healthy. Its quarantine count includes previously marked rows, not only new writes. The scheduled handler logs only bounded state and counts when a sweep is deferred or unavailable; it never logs snapshot bodies. Logs contain bounded classifications and row IDs, never `jobs_json` or validation payloads.

Generation-fenced progress uses `runmesh_job_cleanup_v2`. The old two-column `runmesh_job_cleanup_v1` stays unchanged for rollback compatibility. The new cursor starts at zero with bounded revisits, without copying legacy progress. Current schema initialization performs no DDL. Missing-index repair is independent; failure does not disable healthy reads. Wrong index definitions require operator review and are not dropped automatically.

## Repair one snapshot

Use an authorized D1 operator session for the intended account/database, not ordinary Runner permissions. Pause archive uploads for the affected lifecycle, without stopping unrelated connections. Preserve a private bounded export and its expiration before changing data.

Inspect metadata with bound parameters:

```sql
SELECT snapshot_id, runner_id, lifecycle_id, revision, retention_days,
       retired_at_ms, corrupt_revision, corrupt_detected_at_ms, corrupt_reason
FROM runmesh_job_snapshots_v1
WHERE namespace = ? AND snapshot_id = ?;
```

Recover metadata from a verified backup or the original Runner. Reconcile current recording/retention settings and newer execution receipts. Never guess a result or rerun a command to recreate history. A missing local record does not prove non-execution.

Canonicalize the replacement through the product parser in a built trusted checkout. Use private filenames and the exact Runner ID. The output file is new and owner-only; stdout contains only a count:

```sh
node --import tsx --input-type=module - SOURCE_JSON CANONICAL_JSON RUNNER_ID <<'JS'
import { readFile, stat, writeFile } from 'node:fs/promises';
import { decodeHistorySnapshot, HISTORY_MAX_BYTES } from './apps/worker/src/contracts/history-snapshot.ts';
const [source, target, runner] = process.argv.slice(2);
if (!source || !target || !runner || (await stat(source)).size > HISTORY_MAX_BYTES) throw new Error('Invalid repair input');
const jobs = decodeHistorySnapshot(await readFile(source, 'utf8'), runner);
await writeFile(target, JSON.stringify(jobs), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ validated_jobs: jobs.length }));
JS
```

Bind the canonical JSON, namespace, snapshot ID, Runner ID, lifecycle ID and freshly inspected revision through an existing authenticated D1 client. Do not interpolate payloads into shell commands:

```sql
UPDATE runmesh_job_snapshots_v1
SET jobs_json = ?, revision = revision + 1,
    corrupt_revision = NULL, corrupt_detected_at_ms = NULL, corrupt_reason = NULL
WHERE namespace = ? AND snapshot_id = ? AND runner_id = ? AND lifecycle_id = ?
  AND revision = ? AND retired_at_ms IS NULL;
```

Require exactly one changed row. Zero means changed/retired data: reread and reconcile, never remove the guard or retry blindly. Verify this history and an unrelated Runner, then perform one bounded cleanup. An empty replacement explicitly accepts archive loss; it is never an automatic fallback. Do not delete a namespace/table or relax authorization to repair history.

## Coordinated recovery

The cipher binds the Capabilities object namespace into HKDF and AES-GCM authenticated data, plus the connection context. The same envelope reopens only with the same namespace, key and context. The envelope's `key_id` is a format label, not the actual deployment-secret version. Record secret-version references separately, never secret values.

1. Record source commit/tree, verified artifact digest, Worker/Runner/manager versions, resource identities, bindings, configuration and an independent recovery channel. Retain both secret versions, Runner profiles and service manifests securely.
2. Close new submissions in the isolated target and account for queued/running/unresolved Jobs. Capture current revocations, credential generations and policy changes **outside the rollback set**. Establish a common maintenance boundary or reconcile skew between resource recovery points.
3. Inventory Registry SQL/KV, relevant Runner DOs, Capabilities SQL/KV, D1, and Runner local state/logs/configuration. Save restore and undo points, including quarantine metadata and both cursor tables when present.
4. Restore compatible code/data with execution closed. For ordinary upgrades preserve identities, `INTERNAL_CONTROL_SECRET` and `RUNNER_TOKEN_PEPPER`. Copying ciphertext into a new namespace is not a credential restore. Cross-identity migration requires reviewed migration or fresh enrollment/OAuth authorization, never weaker cryptography.
5. Reapply post-backup revocations and policy changes before opening access. If the independent record is incomplete, keep access closed and rotate/reissue affected credentials. Restored sessions and policy caches are not proof of current authorization.
6. Verify credentials/OAuth and Runner reconnection. Compare original Job IDs/results with retained local records and known external effects. Reconcile unresolved processes; **never automatically replay restored Jobs**. Check healthy and damaged histories separately.
7. Rehearse undo/rollback in the isolated target. Record actual remote recovery independently from local tests and resume only after required evidence is complete.

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) overwrites the database in place and cancels in-flight queries; it is not an automatic clone. Use a separately provisioned synthetic test database, not production, for remote rehearsal. [SQLite-backed DO PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) restores one object's SQL/KV, not the entire deployment, and is unsupported in local development. Check the actual account/backend recovery window.

## Offline acceptance record

The checker validates supplied evidence, not platform authenticity. It grants no permissions and executes no recovery:

```sh
node scripts/check-recovery-evidence.mjs PRIVATE_RECORD_JSON EXPECTED_COMMIT
```

Exit `0`: complete record for this commit. Exit `1`: incomplete/unsuccessful required evidence. Exit `2`: invalid input. Output excludes resource identities, restore points and key references. Local tests never satisfy `remote_pitr`.

Version 1 requires exactly these top-level fields:

| Field | Content |
| --- | --- |
| `schema_version` | `1` |
| `source` | `commit` and `tree`: 40 lowercase hexadecimal characters; `artifact_sha256`: 64 |
| `environment` | `isolated` |
| `credential_strategy` | `preserve` or `reauthorize` |
| `key_version_refs` | Non-secret `internal_control` and `runner_pepper` references |
| `components` | `registry`, `runner_do`, `capabilities`, `d1`, `runner_local` |
| `checks` | All checks listed below, including migration-only checks |

Each component has exactly `status`, `evidence_ref`, `source_identity`, `target_identity`, `restore_point`. Each check has exactly `status`, `evidence_ref`. Status is `passed`, `failed`, `not_run` or `unsupported`; only passed required items with non-null references satisfy acceptance. References match `[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}`: use bounded opaque labels, not bearer URLs, private paths or secret values. `evidence_ref` may be null for missing evidence. Preserved Registry, Runner DO and Capabilities identities must equal their source identities.

Required checks are `coordinated_restore_points`, `same_identity_credentials`, `cross_identity_rejection`, `latest_revocations`, `latest_permissions`, `job_results`, `no_job_replay`, `runner_connection`, `external_oauth`, `rollback`, `remote_pitr`. Also record `fresh_credentials` and `old_credentials_rejected`; both become mandatory for `reauthorize`. Unexecuted/unsupported platform work blocks a full-recovery claim. Signed releases, native Windows/macOS and client-specific checks retain their existing verification records; never reuse another SHA's success.
