# Verification layers and evidence (AR08)

Implementation baseline: `93698cae7939e4034a176d151a113d700ee63615`, after the AR07 Runner boundary extraction. This document describes verification commands in the current checkout. It is not a record that those commands passed, that a release was signed, or that production was upgraded.

## Layers, not a single success label

| Layer | Command / ownership | What it proves when executed successfully |
| --- | --- | --- |
| Shared protocol | Existing protocol workspace tests | Schema and deterministic protocol behavior in the tested runtime |
| Pure-domain rules | `npm run test:domain` | Public queue, authorization projection and retention rules without constructing a Worker, process manager or disk adapter |
| Adapter / documentation contracts | `npm run test:contracts` | Schema examples and actual local file-adapter behavior using isolated temporary data |
| Runner unit and integration | Existing Runner workspace tests | Local permissions, filesystem, processes and recovery on the actual test platform; not every file is a pure unit test |
| Cloudflare integration | Existing Worker workspace tests | Local workerd/Miniflare behavior and SQLite/D1 fixtures, not deployed Cloudflare behavior |
| Tooling / presentation | Existing Node test commands | Build, release, architecture, UI and verification-tool contracts, not a live release |
| Local source transport | `npm run test:e2e` | Real local MCP through Worker and a source Runner |
| Installed package transport | `npm run test:package:e2e` | The newly packed, independently installed Runner participates in the same real local transport scenarios |

`test/verification-plan.json` gives every test file one owner. `npm run check:verification` compares that inventory with actual files, rejects missing/duplicate ownership, and confirms root Node tests are in executable commands. A new test must be classified explicitly; updating the inventory is not proof that it ran. Existing test files are retained. The aggregate `test:unit` command keeps the legacy suites and adds the domain and contract lanes; its historical name does not imply all included tests are pure units.

The new domain lane checks the transitive source import graph. Filesystem, process, Cloudflare and networking imports are disallowed; deterministic `node:crypto` is allowed. New domain tests use public APIs rather than `as any` or private-state casts. This is a source check, not a sandbox, a proof against reflective loading, or a third-party dependency audit. Legacy integration tests still contain fault-injection casts; they were not silently removed to improve a statistic.

## Exact package gate

Both GitHub and GitLab verification execute `test:package:e2e` after source E2E. It packs the current Runner, identifies the sole tarball in a new private directory, hashes its exact bytes and invokes the existing `test-packed-runner.mjs` path. Installation uses `--offline --ignore-scripts` and an empty dependency cache. The installed CLI, rather than the source CLI, runs against a temporary local Worker. No host service, production registration code or production database is used.

The wrapper cross-checks available CI SHA declarations with the checkout, confirms source identity and archive digest after execution, and requires both successful process termination and a consistent machine test report with at least one passed test. A fake exit zero, empty report, failed suite, unfinished test or inconsistent counter cannot become passing evidence. `pending`/skipped and todo counts remain separate. A failed rerun replaces a previous successful report.

The bounded shareable result is `.verification/package-e2e.json` and a JSON line in the CI log. It includes source commit/tree and clean/dirty state, artifact SHA256 and bytes, actual platform/architecture/Node, elapsed time and test counters. It excludes test names, assertion bodies, stack traces, email addresses and absolute paths. Ordinary detailed test logs remain separate. Reports are ignored by Git; they are not uploaded to a Worker or written per production request.

A local package is explicitly `signed: false`, `published: false`. Its evidence is self-reported, not a cryptographic or reproducible-build attestation. A dirty checkout is labelled dirty, never advertised as that commit's clean source. Source identity does not cover ignored inputs or dependency integrity. Do not run concurrent builds in the same worktree.

## Facts and executable examples

`docs/current-facts.md` is generated from the current package, protocol, actual MCP catalog, resource-binding configuration and reviewed release-state record. `docs/tool-examples.md` comes from `docs/tool-examples.json`; every input is checked against its real Zod schema, including cross-field constraints. Every tool and mapped action needs a valid example; negative examples must remain rejected. Validation never invokes the tool handler. Synthetic commands, IDs and hashes must not be treated as permission or deployment instructions.

Run `npm run generate:facts` only after an intentional source/example change, then review the generated diff. `npm run check:docs` checks rather than rewrites those documents. Stale generated examples and facts fail the ordinary CI gate. This registry covers its documented examples, not every free-form JSON block in every historical document.

## Evidence that remains separate

GitHub native jobs execute the domain/contract lanes, Runner tests and applicable tooling on Linux, macOS and Windows. Full installed-package transport is required in the Linux verification jobs on both hosts; a successful Linux result does not prove native package E2E on other systems. Existing platform skips are reported, not relabelled as passes.

Signed-release verification, deployed Worker/Runner observation, account-wide quota/hibernation acceptance and actual host-catalog refresh are separate checks. The local package report records all four as `not_run`. A release-state file is a reviewed source record, not a fresh network verification of the assets. Production observations need their own time, exact version/commit and external evidence. Historical CI or a different platform must never fill those gaps.

AR08 adds bounded build/test work, no runtime variables, cloud tables, polling, service restarts or production writes. Tests should evolve with each feature; passing this layer does not establish complete code coverage or finish every remaining architecture task.
