# Data recovery

Version: 1
Applies to: optional D1 Job history, control-plane data, and encrypted credentials
Required permissions: source review is read-only; mutations require the existing provider administrator authority

## Goal

Restore data without broadening authorization, extending malformed-payload retention indefinitely, or replaying old work.

## Procedure

1. Identify the source commit, deployment, exact resource identities, key-version references and isolated target. Use the [data recovery guide](../data-recovery.md).
2. For a damaged snapshot, inspect metadata and repair only the observed namespace/Runner/lifecycle/revision using the documented bound-parameter CAS procedure. Retain diagnostic evidence privately with a finite lifetime.
3. For a coordinated restore, keep submissions closed, preserve original identity or reauthorize explicitly, and reconcile revocations and permissions from outside the rollback set.
4. Compare original Job results and live process state without automatic replay. Verify the rollback path.
5. Validate the private record with `node scripts/check-recovery-evidence.mjs PRIVATE_RECORD_JSON EXPECTED_COMMIT`. Local tests do not satisfy remote PITR or external-provider acceptance.

## Exit conditions

- The affected history returns verified metadata and healthy Runner history remains available, or explicitly recorded archive loss remains visible as unavailable.
- Full restore acceptance requires every required same-commit record to pass, including current authorization and remote recovery evidence.
- Leave missing platform results as `not_run` or `unsupported`. An evidence validator is not an authority or a live platform attestation.
