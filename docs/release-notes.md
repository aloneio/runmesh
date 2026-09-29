# Release notes

[Chinese](release-notes.zh-CN.md) · [Documentation](README.md) · [Upgrade guide](upgrading.md)

## 0.1.6 — release candidate

This candidate is being prepared for release; the current stable package remains 0.1.5.

- Connect MCP services from the control panel using a URL and either no authentication or OAuth. Connected AI clients can use the enabled tools immediately.
- Install Skills from SKILL.md and supporting text files or a folder, and confirm updates directly in the control panel.
- Production configuration now includes shared MCP and Skill storage. Initial setup also prepares the separate OAuth credential vault.
- Local development now initializes shared MCP and Skill storage alongside Miniflare runtime metadata. End-to-end checks cover library access without selecting a Runner.
- Preparing a stable candidate keeps development downloads on the current prerelease series; the next patch series starts after stable publication is recorded.

- Console navigation now recovers from stalled page requests after 25 seconds. When a full page load is needed, it opens your most recently selected destination.
- Development release cache recovery now stops its Registry request and response reader when the recovery deadline ends, including when the request is still waiting for headers.
- Cold development downloads use the remaining 20-second refresh budget to recover a release being verified by another instance. Cache reads retain a one-second limit, retries back off, and a spent refresh deadline permits at most one additional second for storage recovery. Verified cache expiry stays unchanged and recovery does not repeat upstream discovery.
- Failed development release refreshes recover the most recently verified usable cache record, including updates from another instance, while retaining its original expiry. Foreground and background regressions cover recovery over older in-memory values.
- The Runner Git library validates timeout options before starting a process, so invalid configuration cannot leave an unmanaged child. Lifecycle regressions cover startup failures, expired deadlines, and snapshot cleanup.
- Runner baseline checks use one isolated index for status and flag inspection, preventing concurrent flag changes from hiding uncommitted edits. Fewer snapshots and Git processes retain the 1.5-second observation budget and a fresh final commit check.
- Concurrent development downloads now wait for cache recovery to finish before reporting a failed refresh. Registry cache reads and writes have deadlines, so stalled storage cannot indefinitely delay a verified download.
- Development release discovery now recovers from a failed refresh using a verified release saved by another instance. Runner pages and downloads use the same release state for their Registry binding.
- Adding an AI connection now opens computer permissions automatically when you select “MCP, Skills and computer access”. Switching access types keeps your permission choices.
- Development installers now wait for an ongoing release verification when several users download immediately after a cold start. Concurrent requests share the verified result once it is ready, within a bounded wait.

## 0.1.5 — published stable release

Published on **September 23, 2026** as an [immutable stable release](https://github.com/aloneio/runmesh/releases/tag/v0.1.5) with a signed portable Runner package. The release was built from protected main commit `77e82a1b59737a42cc090064651d1b0531890f21`; the independently verified manifest SHA256 is `34da9baefabddd882aeef79151b132b1de4086fce54de7a46fe853a7e8dac18a`.

This release includes a Windows installation fix: on localized Windows hosts, a missing `RunmeshRunner` Task Scheduler task is now recognized through the locale-independent COM API. Permission and Task Scheduler failures remain fail-closed.

Follow the [upgrade guide](upgrading.md) to update an existing installation while preserving its credentials and configuration.

## 0.1.4 — published stable release

Published on **September 20, 2026** as an [immutable stable release](https://github.com/aloneio/runmesh/releases/tag/v0.1.4) with a signed portable Runner package.

**0.1.4** improves task control, MCP recovery, workspace context management and installation. See [release status](release-readiness.md) for verified package availability and hosted installation status, and the [upgrade guide](upgrading.md) to update your Worker, Runner and client.

### Improvements after upgrading compatible components

- **More reliable task control.** Cancellation keeps uncertain live processes under supervision until their state is resolved. Concurrent recovery respects the recorded cancellation delivery. Input errors include guidance for checking the original process before sending more input.
- **Clearer recovery on Linux.** After a Runner restart, unfinished Jobs whose processes have exited resolve to interrupted, or cancelled when recorded cancellation delivery supports that outcome.
- **Clearer MCP calls and recovery.** Action-specific tool definitions, workspace-bound Job queries and structured errors help you follow the original operation after an outage. Query the online Runner with the original Job and workspace IDs when cloud history is unavailable.
- **More control over saved context and paged reads.** Inspect Context storage usage and prune selected old revisions. Optional snapshot reads keep file pages tied to captured content, while append reads follow one Job-log generation. Runner diagnostics help you check support before using these features.
- **Fewer idle history uploads.** Compatible Worker/Runner pairs upload recorded Job metadata when it changes, then stop the history timer after acknowledgement. Ordinary log reads stay on demand. Heartbeats, authorization and maintenance continue to use account resources.
- **Stronger local and distribution boundaries.** Additional checks reject unsafe special-file replacements in metadata and release inputs. Release health checks reject oversized or stalled responses before completing preflight. Published packages keep their original identity; the stable tag publisher now explicitly verifies the project tagger identity.
- **Safer installation and mixed-version operation.** Hosted installers serialize installation, credential refresh and removal, and roll back only paths they created. Windows release downloads keep a deadline through the response body; dedicated service provisioning fixes macOS group selection and Windows directory creation. MCP Runner selection rechecks the original credential at commit, and Job metadata rejects concurrent replacement or rewriting.
- **Updated user documentation.** English and Chinese guides distinguish first installation, compatible upgrades, task recovery, stable releases and development testing. Older migration and audit records are separated from the everyday instructions.

### Upgrade notes

Follow the [upgrade guide](upgrading.md): deploy the compatible Worker, install the target Runner package, then refresh the client tool catalog. Preserve existing v2 resources and credentials, and verify `shell` followed by queries for the same Job before restoring ordinary workloads.

Context storage and prune require support advertised by the Runner during its authenticated handshake. On `runner_upgrade_required`, check the installed version and reconnect after upgrading. The existing connection remains available for supported methods. A connection hibernated before the Worker upgrade may also need a fresh handshake.

### Operating guidance

Commands run with the Runner service account's OS privileges; use a container or virtual machine for untrusted code. Export output you need to retain beyond the configured log limits. Inspect recovered Jobs marked `unknown`, and confirm the final Job state after cancellation before starting replacement work.

## 0.1.3 — published stable release

Published on **September 14, 2026** as an immutable stable release. It introduced bounded, fair multi-client Job queues with authorization checked again before queued work starts, and server-rendered single-language administrator pages. User commands and logs retain their original content. History loads on request within its configured limits.

The original signed package remains available under its fixed release identity. Follow the [upgrade guide](upgrading.md) to check your installed components.

## Earlier releases

0.1.2 introduced batched recent Job metadata, manual history loading and independently controlled retention. 0.1.1 added maintenance and inspection improvements over the signed portable Runner and protocol-v2 foundation in 0.1.0.

[Archived release notes](maintainers/release-history.md) retain details of earlier releases and their specific migration procedures.
