# Release notes

[Chinese](release-notes.zh-CN.md) · [Documentation](README.md) · [Upgrade guide](upgrading.md)

## 0.1.7 — published stable release

[Runmesh 0.1.7](https://github.com/aloneio/runmesh/releases/tag/v0.1.7) is available with a signed portable Runner package. See [release status](release-readiness.md) for installation and upgrade steps.

### Runner services

- Linux user services use the current account's local service manager for installation, status checks, stopping, restarting and removal.
- On Linux, macOS and Windows, user services consistently start in user mode. Updating an existing service refreshes its launch settings while retaining custom program paths and arguments.

### MCP connections and reliability

- Temporary control-plane interruptions preserve the existing OAuth connection. Authorization opens when the account needs to sign in again.
- Runner connections release unused responses during disconnects and temporary control-plane failures.

### Control panel

- Client lists show concise credential statuses and put dates and UTC times on separate lines, with full timestamps available for reference.

### Security

- Updated Hono to 4.13.7, which fixes GHSA-hxh3-vqpv-xpqv in JSX rendering.

### Upgrade

Follow the [upgrade guide](upgrading.md) to update the control plane and Runner. For a user service, run `install --user` with the updated service executable and existing profile to apply its launch update. Existing account connections, Runner profiles and workspace settings carry over.

## 0.1.6 — published stable release

[Runmesh 0.1.6](https://github.com/aloneio/runmesh/releases/tag/v0.1.6) is available with a signed portable Runner package. See the [upgrade guide](upgrading.md) to move an existing installation to the current release.

### MCP and Skill

- Connect an MCP from its URL using no authentication or OAuth. Sign-in returns to the control panel and loads the available tools automatically.
- Start a fresh provider sign-in with **Reconnect**. Refreshing tools also opens authorization when the account needs it.
- Install a Skill folder or SKILL.md with supporting text files. Review same-name updates and publish them to all connected clients.
- Use shared MCP tools and Skills directly from an AI connection. Choose computer access to add Runner file and command tools; the permission choices open automatically.

### Daily use and reliability

- Console links open the intended section below the header, and new pages start at their heading. Switching between long and short pages fits the content to the page. Fast navigation keeps the browser address aligned with the displayed page; a stalled request reloads the last selected destination after 25 seconds.
- The Runner installation page uses space more closely on narrow screens. Command panels readjust when the window size changes, clearing excess blank space after resizing.
- Runner details show when workspace settings are still being applied and report stalled queries after a limited wait.
- Development downloads and Runner pages show the same verified version. Concurrent downloads share verification, and a failed refresh can recover a still-valid verified release.
- Git checks identify concurrent workspace changes more consistently and catch invalid timeout settings before starting a command.
- English and Chinese guides now separate MCP/Skill setup from computer access, with direct instructions for OAuth, Skill updates and version selection.

### Upgrade

Runmesh 0.1.6 adds shared MCP connections and Skills. Preserve the existing deployment secrets so connected OAuth accounts retain their credentials. Deploy the reviewed release activation, install the signed Runner package and refresh client catalogs using the [upgrade guide](upgrading.md).

After the stable release is verified and activated, new development batches use the next patch series. The installation page offers the currently verified, protocol-compatible development package.

## 0.1.5 — published stable release

Published on **September 23, 2026** as an [immutable stable release](https://github.com/aloneio/runmesh/releases/tag/v0.1.5) with a signed portable Runner package. The release was built from protected main commit `77e82a1b59737a42cc090064651d1b0531890f21`; the independently verified manifest SHA256 is `34da9baefabddd882aeef79151b132b1de4086fce54de7a46fe853a7e8dac18a`.

This release includes a Windows installation fix: on localized Windows hosts, a missing `RunmeshRunner` Task Scheduler task is now recognized through the locale-independent COM API. Permission or Task Scheduler errors stop installation and report the cause for the administrator to resolve.

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
