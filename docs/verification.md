# Testing and release verification

[简体中文](verification.zh-CN.md) · [Documentation](README.md) · [Release status](release-readiness.md)

Use this guide when validating a source change or preparing an installation for release. Run commands from the repository root after installing the pinned toolchain and dependencies with `npm ci`. Choose the checks that cover your local change; release candidates must also pass the complete required CI. For an existing deployed installation, start with the [upgrade guide](upgrading.md).

## Choose the appropriate checks

| Layer | Command / ownership | What it proves when executed successfully |
| --- | --- | --- |
| Shared protocol | `npm run test --workspace=@aloneio/runmesh-protocol` | Schema and deterministic protocol behavior in the tested runtime |
| Pure-domain rules | `npm run test:domain` | Public queue, authorization projection and retention rules without constructing a Worker, process manager or disk adapter |
| Adapter / documentation contracts | `npm run test:contracts` | Schema examples and actual local file-adapter behavior using isolated temporary data |
| Runner unit and integration | `npm run test --workspace=@aloneio/runmesh-runner` | Local permissions, filesystem, processes and recovery on the actual test platform |
| Cloudflare integration | `npm run test --workspace=@aloneio/runmesh-worker` | Local workerd/Miniflare behavior and SQLite/D1 fixtures |
| Build and release tooling | `npm run test:release-tools` | Build, installer, release, architecture and verification-tool behavior |
| Local source transport | `npm run test:e2e` | Real local MCP through Worker and a source Runner |
| Installed package transport | `npm run test:package:e2e` | The newly packed, independently installed Runner participates in the same real local transport scenarios |
| Browser flows | `npm run browser:install`, then `npm run test:browser` | Browser behavior against a local Worker |
| Tracked security regressions | `npm run test:security` on Linux with a clean checkout | Regression results and release-readiness evidence for the checked-out candidate |

`npm run test:unit` combines domain, contract, workspace and selected presentation tests; it includes both unit and integration tests. `npm test` adds source E2E, but does not replace the full CI workflow. Local Worker and browser tests do not check a deployed Cloudflare account.

The candidate-bound `test:security` command rejects non-Linux hosts and uncommitted source changes. While developing on Windows/macOS or with local edits, run the relevant individual regression suites; obtain release evidence from the clean Linux candidate run.

When adding a test file, assign it one owner in `test/verification-plan.json`. Run `npm run check:verification` to detect missing or duplicate ownership and confirm that root Node tests appear in executable commands.

Keep domain tests independent of filesystem, process, Cloudflare and networking adapters, and use public APIs instead of private-state casts. The source import check permits deterministic `node:crypto`. It checks source dependencies; it does not sandbox code or audit third-party package internals.

## Verify the installed package

The Linux verification jobs on GitHub and GitLab execute `test:package:e2e` after source E2E. The command packs the current Runner into a new private directory, requires exactly one tarball, hashes it and invokes `test-packed-runner.mjs`. Installation uses `--offline --ignore-scripts` and an empty dependency cache. The installed CLI runs against a temporary local Worker using synthetic enrollment data; it does not install a host service or use a production database.

The wrapper cross-checks available CI SHA declarations with the checkout, confirms source identity and archive digest after execution, and requires both successful process termination and a consistent machine test report with at least one passed test. A fake exit zero, empty report, failed suite, unfinished test or inconsistent counter cannot become passing evidence. `pending`/skipped and todo counts remain separate. A failed rerun replaces a previous successful report.

The bounded shareable result is `.verification/package-e2e.json` and a JSON line in the CI log. It includes source commit/tree and clean/dirty state, artifact SHA256 and bytes, actual platform/architecture/Node, elapsed time and test counters. It excludes test names, assertion bodies, stack traces, email addresses and absolute paths. Ordinary detailed test logs remain separate. Reports are ignored by Git; they are not uploaded to a Worker or written per production request.

A local package is explicitly `signed: false`, `published: false`. Its evidence is self-reported, not a cryptographic or reproducible-build attestation. A dirty checkout is labelled dirty, never advertised as that commit's clean source. Source identity does not cover ignored inputs or dependency integrity. Do not run concurrent builds in the same worktree.

## Check documentation and examples

`docs/current-facts.md` is generated from the current package, protocol, actual MCP catalog, resource-binding configuration and reviewed release-state record. `docs/tool-examples.md` comes from `docs/tool-examples.json`; every input is checked against its real Zod schema, including cross-field constraints. Every tool and mapped action needs a valid example; negative examples must remain rejected. Validation never invokes the tool handler. Synthetic commands, IDs and hashes must not be treated as permission or deployment instructions.

Run `npm run generate:facts` only after an intentional source/example change, then review the generated diff. `npm run check:docs` checks rather than rewrites those documents. Stale generated examples and facts fail the ordinary CI gate. This registry covers its documented examples, not every free-form JSON block in every historical document.

## Record release and deployment results separately

GitHub native jobs execute the domain/contract lanes, Runner tests and applicable tooling on Linux, macOS and Windows. Full installed-package transport is required in the Linux verification jobs on both hosts; a successful Linux result does not prove native package E2E on other systems. Existing platform skips are reported, not relabelled as passes.

Signed-release verification, deployed Worker/Runner observation, account-wide quota/hibernation acceptance and actual host-catalog refresh are separate checks. The local package report records all four as `not_run`. A release-state file is a reviewed source record, not a fresh network verification of the assets. Production observations need their own time, exact version/commit and external evidence. Historical CI or a different platform must never fill those gaps.

For release decisions, retain the exact commit, CI run, platform, skips and result for each required check. Use [release status](release-readiness.md) for publication requirements and [build provenance](build-provenance.md) to compare a deployed Worker with its source.
