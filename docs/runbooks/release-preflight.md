# Release preflight

Version: 1  
Applies to: signed Runner assets, Worker compatibility, and hosted CI evidence  
Required permissions: none for source review; release activation requires the existing explicit administrator workflow  

## Goal

Decide whether a candidate is ready to be considered for manual activation while preserving signed immutable assets, compatibility gates, and an independent recovery path.

## Procedure

1. Record the source commit SHA and confirm the working tree used to build the candidate is intentional.
2. Require the hosted CI gate for that SHA. GitHub and GitLab must retain the shared release-relevant checks; native platform evidence remains separately identified.
3. Verify package/version consistency, release-contract checks, license checks, Worker dry-runs, package smoke tests, and the signed asset manifest using the repository release tooling.
4. Record the intended Worker/Runner compatibility combination. Do not assume adding optional protocol fields is compatible with a strict older peer.
5. Confirm the upgrade target has enough disk space, no unaccounted active Jobs, the expected service identity, and an independent recovery/control channel before any service restart.
6. Keep activation separate from preflight. A successful preflight does not enable distribution, overwrite an older immutable asset, deploy the Worker, or restart the Runner.

## Exit conditions

- Ready for an explicit activation decision only when required evidence is `passed` and linked to the candidate SHA.
- Stop on signature/version mismatch, missing native evidence required by the release, incompatible protocol combinations, unknown service identity, or unavailable recovery channel.
- Record `not_run` or `unsupported` rather than converting absent evidence into success.
