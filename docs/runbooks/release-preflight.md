# Release preflight

Version: 1
Applies to: signed Runner assets, Worker compatibility, and hosted CI evidence
Required permissions: none for source review; release activation requires the existing explicit administrator workflow

## Goal

Determine whether a candidate is ready for an activation decision using evidence tied to its source SHA, signed assets, compatible components and recovery procedure.

## Procedure

1. Record the candidate's source SHA and inspect the working tree used to build it.
2. Require hosted CI evidence for that SHA. Check the shared release-relevant jobs on GitHub and GitLab, and identify each required native-platform result.
3. Run package/version, release-contract, license, Worker dry-run and package smoke checks. Verify the signed asset manifest with the repository's release tooling.
4. Record the intended Worker/Runner versions and test their protocol combination. Include strict older peers when adding optional fields or methods.
5. Before a host restart, check disk space, account for active Jobs, confirm the service identity, and verify an independent recovery/control channel.
6. Present the evidence for the activation decision. After approval, follow the release procedure for publication and distribution activation, the deployment procedure for the Worker, and the host upgrade procedure for each Runner. Preserve existing immutable release assets.

## Exit conditions

- Ready for an activation decision when every required result is `passed` and linked to the candidate SHA.
- Resolve signature/version mismatches, missing required native evidence, incompatible protocol combinations, unknown service identity or an unavailable recovery channel before proceeding.
- Record unexecuted or unsupported checks as `not_run` or `unsupported`, with their reason.
