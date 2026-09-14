# Release readiness — 0.1.3

State: CANDIDATE, not RELEASED. Distribution for this candidate is not ENABLED. The existing production installer stays available until independent publication verification and an activation commit. `release/release-state.json` records the lifecycle.

Version 0.1.3, tag v0.1.3, stable channel, protocol v2 with negotiated queue frames, and runmesh-runner-0.1.3.tgz are fixed inputs. The reviewed Ed25519 key remains runmesh-preview-2026-01. Existing immutable releases retain their original bytes and provenance.

The exact protected main tip must pass verify-all on supported Node LTS and native platforms. The final portable archive is installed offline with scripts disabled and runs real Worker/Runner E2E before signing. Manifest, signature, checksums and annotated tag must agree, including independently downloaded draft and public assets. Only then may the lifecycle be RELEASED and distribution ENABLED with `RUNMESH_SIGNED_RELEASE_AVAILABLE=0.1.3`.

Includes bounded fair multi-client queues, execution-time authorization, server-rendered single-locale UI and explicit history refresh without page cross-fades. See [queue/UI contract](job-queue-and-localization.md). No queue polling timer is introduced; necessary heartbeats, authorization and bounded maintenance remain metered.

Production retains the current v2 DO identities, production-only legacy tombstones and D1. Never revert declarative lifecycle to old migrations. Publishing does not upgrade or restart installed Runners. GitLab main activation and runtime verification are separate from publication.
