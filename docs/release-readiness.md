# Release readiness — 0.1.3

**State: RELEASED. Distribution: ENABLED in this activation commit.** Immutable v0.1.3 was published from protected main `90395a1a37e608ed40fe3646c1a06f5d4d4f4d83` at `2026-09-14T14:03:29Z` by successful Release run `34852575044`. All nine public assets were independently fetched without GitHub authentication and verified using the source trust keyring. Manifest SHA256: `ba84fce036385127eb69f7c677ba8cc89757c038797414c66e8e2861286cbbbe`. Runner tarball: `6bf9c34bf22ddbba4f86d08767ae817ebe68b7dd5b8a88621e9bfb872aa02ddf` (691084 bytes). Production activation still requires the merged commit to reach GitLab main and Cloudflare; this record alone is not deployment evidence.

Version 0.1.3, tag v0.1.3, stable channel, protocol v2 with negotiated queue frames, and runmesh-runner-0.1.3.tgz are fixed inputs. The reviewed Ed25519 key remains runmesh-preview-2026-01. Existing immutable releases retain their original bytes and provenance.

The exact protected main tip must pass verify-all on supported Node LTS and native platforms. The final portable archive is installed offline with scripts disabled and runs real Worker/Runner E2E before signing. Manifest, signature, checksums and annotated tag must agree, including independently downloaded draft and public assets. Only then may the lifecycle be RELEASED and distribution ENABLED with `RUNMESH_SIGNED_RELEASE_AVAILABLE=0.1.3`.

Includes bounded fair multi-client queues, execution-time authorization, server-rendered single-locale UI and explicit history refresh without page cross-fades. See [queue/UI contract](job-queue-and-localization.md). No queue polling timer is introduced; necessary heartbeats, authorization and bounded maintenance remain metered.

Production retains the current v2 DO identities, production-only legacy tombstones and D1. Never revert declarative lifecycle to old migrations. Publishing does not upgrade or restart installed Runners. GitLab main activation and runtime verification are separate from publication.

## Post-release source changes

The [2026-09-17 pre-release audit](release-audit-20260917.md) covers later dev changes, not the immutable v0.1.3 assets above. A new stable version and exact-candidate security evidence are required before publishing those changes. Do not interpret this historical activation record as their release or deployment approval.

The [2026-09-17 follow-up](release-followup-20260917.md) records additional source repairs whose full candidate verification is still pending. Its isolated helper checks and earlier baseline CI are not acceptance evidence for the repaired checkout.

The [cumulative candidate audit](release-final-audit-20260917.md) records later repository regression runs and further authentication-boundary repairs. Clean-candidate security evidence and stable publication/deployment acceptance remain distinct requirements.

The [independent oci0 candidate review](release-review-20260917-1612.md) found a failed unit gate, corrected permission-sensitive test fixtures and browser mutation outage statuses, and records the remaining post-repair verification gap. Its pre-repair 25/26 gate results do not approve the modified candidate for release.

The [final admission and bounded receipt audit](release-admission-audit-20260917.md) records further bridge/dequeue authorization, stream-budget and Job-identity repairs and confirms that the existing nonduplicating GitLab dev-mirroring policy remains intact. Its source regression results remain separate from clean-candidate, provider, installed-component and stable-release acceptance.

The [Runner storage boundary audit](release-storage-audit-20260917.md) records SEC17 special-file open repairs and their mandatory candidate-bound regression coverage. Source verification remains separate from stable publication and installed-component acceptance.

The [2026-09-18 release-tool input audit](release-tools-audit-20260918.md) records nonblocking FIFO rejection in bounded release and MCP catalog readers, executable tooling regressions, and the remaining deployed-component acceptance gaps. Earlier baseline CI is not acceptance evidence for a repaired candidate.
