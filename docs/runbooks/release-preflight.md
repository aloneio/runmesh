# Release preflight

Version: 1
Applies to: signed Runner assets, Worker compatibility, and hosted CI evidence
Required permissions: none for source review; release activation requires the existing explicit administrator workflow

## Goal

Determine whether a candidate is ready for an activation decision using evidence tied to its source SHA, signed assets, compatible components and recovery procedure.

## Procedure

1. Record the candidate's source SHA and inspect the working tree used to build it.
2. Require hosted CI evidence for that SHA. Check GitHub's `verify-all` and its required jobs from the same selected run attempt, GitLab's `verify` and `browser`, and each required native-platform result. Use the [verification guide](../verification.md) to interpret reports and platform requirements.
3. Run `npm run check:versions`, `node scripts/check-release-contract.mjs`, `npm run check:licenses`, `npm run validate:worker -- --dry-run` and `npm run pack:smoke`. Repeat Worker dry-run for `--env development` and `--env production` as required by CI. Verify the signed asset manifest through the [independent package verification procedure](../portable-runner-installation.md#independently-verify-a-downloaded-package).
4. Record the intended Worker/Runner versions and test their protocol combination. Include strict older peers when adding optional fields or methods.
5. Before a host restart, check disk space, account for active Jobs, confirm the service identity, and verify an independent recovery/control channel.
6. Present the evidence for the activation decision. After approval, follow the [release procedure](../maintainers/release-process.md) for publication and distribution activation, the [deployment procedure](../deployment.md) for the Worker, and the [host upgrade procedure](../upgrading.md) for each Runner. Preserve existing immutable release assets.

## Exit conditions

- Ready for an activation decision when every required result is `passed` and linked to the candidate SHA.
- Resolve signature/version mismatches, missing required native evidence, incompatible protocol combinations, unknown service identity or an unavailable recovery channel before proceeding.
- Record unexecuted or unsupported checks as `not_run` or `unsupported`, with their reason.
