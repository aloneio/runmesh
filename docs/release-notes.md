# Release notes

[简体中文](release-notes.zh-CN.md) · [Documentation](README.md) · [Upgrade guide](upgrading.md)

## Next stable release — not yet published

These changes describe development source after the immutable **0.1.3** release. They are not included in the existing 0.1.3 archive. A new stable version, signed assets and completed rollout checks are still required. The release version will be assigned through the reviewed release process; a development prerelease is not a stable release.

### Changes users can expect after upgrading compatible components

- **More reliable task control.** Cancellation keeps live, unverified processes under supervision instead of reporting false completion or releasing their execution slots. Concurrent recovery requests respect an existing cancellation-delivery record. Input handling reports delivery errors and closes its observers without treating an uncertain send as safe to replay.
- **Clearer MCP calls and recovery.** Action-specific tool definitions, workspace-bound Job queries and structured error guidance make it easier to follow the original operation after an outage. File and Job output stay bounded; a missing cloud history record does not mean a command never ran.
- **Less unnecessary history work.** Compatible Worker/Runner pairs use change-driven optional history reporting. Unrecorded tasks and ordinary log reads do not enable history uploads; unchanged acknowledged snapshots do not keep an idle upload loop alive. Heartbeats, authorization and necessary maintenance remain, so this is not a zero-cost guarantee.
- **Stronger local and distribution boundaries.** Additional checks reject unsafe special-file replacements in metadata and release inputs. Published packages keep their original identity; the stable tag publisher now explicitly verifies the project tagger identity.
- **Updated user documentation.** English and Chinese guides distinguish first installation, compatible upgrades, task recovery, stable releases and development testing. Older migration and audit records are separated from the everyday instructions.

### Upgrade notes

Worker deployment, Runner installation and client tool-catalog refresh are separate operations. New source features require the relevant compatible components; publishing or merging alone does not restart an installed service. Follow the [upgrade guide](upgrading.md), preserve existing v2 resources and credentials, and verify `shell` followed by queries for the same Job before restoring ordinary workloads.

### Limits to understand

Command execution is not an operating-system sandbox. Logs and recent cloud snapshots are bounded, and discarded output cannot be recovered through Runmesh. Recovered Jobs may remain `unknown`; a cancellation request is not immediate proof of exit. No automatic upgrade or rollback, multi-tenant organization/billing system, hosted IDE, browser automation or model API is included.

## 0.1.3 — published stable release

Published on **September 14, 2026** as an immutable stable release. It introduced bounded, fair multi-client Job queues with authorization checked again before queued work starts, and server-rendered single-language administrator pages without translating user commands or logs. History remains explicitly loaded and bounded.

That package remains unchanged. See [release status](release-readiness.md) for the reviewed distribution record; it is not proof that any particular Worker or Runner has been upgraded.

## Earlier releases

0.1.2 introduced batched recent Job metadata, manual history loading and independently controlled retention. 0.1.1 added maintenance and inspection improvements over the signed portable Runner and protocol-v2 foundation in 0.1.0.

[Archived release notes](maintainers/release-history.md) retain the original historical details. Instructions for old development previews and pre-v2 clean-break transitions must not be reused as ordinary upgrade steps.
