# Release notes

[Chinese](release-notes.zh-CN.md) · [Documentation](README.md) · [Upgrade guide](upgrading.md)

## 0.1.4

**0.1.4** improves task control, MCP recovery, workspace context management and installation. See [release status](release-readiness.md) for verified package availability and hosted installation status, and the [upgrade guide](upgrading.md) to update your Worker, Runner and client.

### Improvements after upgrading compatible components

- **More reliable task control.** Cancellation keeps uncertain live processes under supervision until their state is resolved. Concurrent recovery respects the recorded cancellation delivery. Input errors include guidance for checking the original process before sending more input.
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
