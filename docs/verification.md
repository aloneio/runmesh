# Testing and release verification

[简体中文](verification.zh-CN.md) · [Documentation](README.md) · [Release status](release-readiness.md)

Use this guide when validating a source change or preparing an installation for release. Run commands from the repository root after installing the pinned toolchain and dependencies with `npm ci`. Choose the checks that cover your local change; release candidates must also pass the complete required CI. For an existing deployed installation, start with the [upgrade guide](upgrading.md).

## Choose the appropriate checks

| Layer | Command / ownership | What it proves when executed successfully |
| --- | --- | --- |
| Shared protocol | `npm run test --workspace=@aloneio/runmesh-protocol` | Schema and deterministic protocol behavior in the tested runtime |
| Pure-domain rules | `npm run test:domain` | Isolated queue, authorization projection and retention rules through public APIs |
| Adapter / documentation contracts | `npm run test:contracts` | Schema examples and actual local file-adapter behavior using isolated temporary data |
| Runner unit and integration | `npm run test --workspace=@aloneio/runmesh-runner` | Local permissions, filesystem, processes and recovery on the actual test platform |
| Cloudflare integration | `npm run test --workspace=@aloneio/runmesh-worker` | Local workerd/Miniflare behavior and SQLite/D1 fixtures |
| Build and release tooling | `npm run test:release-tools` | Build, installer, release, architecture and verification-tool behavior |
| Local source transport | `npm run test:e2e` | Real local MCP through Worker and a source Runner |
| Installed package transport | `npm run test:package:e2e` | The newly packed, independently installed Runner participates in the same real local transport scenarios |
| Browser flows | `npm run browser:install`, then `npm run test:browser` | Chromium navigation against a local Worker, plus MCP, Skill and OAuth page interactions |
| Tracked security regressions | `npm run test:security` on Linux with a clean checkout | Regression results and release-readiness evidence for the checked-out candidate |

`npm run test:unit` combines domain, contract, workspace and selected presentation tests. `npm test` adds source E2E. The complete release CI also runs the package, browser, platform, tooling and security checks. Worker and browser test commands use local test environments; deployed-instance checks follow the [upgrade guide](upgrading.md).

Run candidate-bound `test:security` on Linux from a clean checkout. For development on Windows/macOS or with local edits, use the relevant individual regression suites, then collect release evidence from the clean Linux candidate run.

When adding a test file, assign it one owner in `test/verification-plan.json`. Run `npm run check:verification` to detect missing or duplicate ownership and confirm that root Node tests appear in executable commands.

Transport tests live in `test/e2e/`; browser tests live in `test/browser/`. Each suite starts its own temporary Worker, and the browser gate also runs isolated product scenarios. The collection check compares each suite with its ownership manifest. Add new cases to the entry point for their module.

Exercise domain rules through public APIs and keep adapter integration in its dedicated suites. The [source dependency checks](architecture-gates.md) define the allowed imports, including deterministic `node:crypto`.

## Read CI results

GitHub runs verification for pushes to `dev` and `main`, and for pull requests. GitLab runs full verification for merge requests, pushes to `main`, manual runs and schedules. To verify the development branch there, choose `dev` under **New pipeline**. This keeps routine development checks on GitHub while providing an independent GitLab result for cross-forge acceptance.

| Job | Main checks |
| --- | --- |
| `verify` | Protocol, domain, Worker, Runner, documentation, architecture, and source and installed-package transport |
| `browser` | Real Chromium navigation, layout, MCP connections, OAuth and Skill interactions |
| `Runner native checks` | Native behavior on Windows, Linux and macOS; Windows also runs the complete transport suite |
| `Runner LTS` | Runner behavior on the declared Node LTS versions |

GitHub's `verify-all` aggregates every required job. GitLab acceptance checks both `verify` and `browser`; Worker deployment builds have a separate result.

Open `ci-results/` in the job artifacts for JSON summaries and JUnit reports. Transport evidence includes source identity, platform, test counts, and source locations and error categories on failure. Browser checks use the same diagnostic rules. Reports are retained for 14 days after GitHub verification, browser and Windows transport jobs, and after GitLab verification and browser jobs. To investigate log-pagination failures, use the reported field states, byte counts and source location to identify the failing step.

Windows initializes its transport reports before installing dependencies. A `not_run` result means the transport step has not started; check the preceding job steps for the failure.

## Verify the installed package

The Linux verification jobs on GitHub and GitLab execute `test:package:e2e` after source E2E. The command packs the current Runner into a new private directory, requires exactly one tarball, hashes it and invokes `test-packed-runner.mjs`. Installation uses `--offline --ignore-scripts` and an empty dependency cache. The installed CLI runs against a temporary local Worker with isolated state and synthetic enrollment data.

A passing run requires matching CI/checkout source identity, an unchanged archive digest, successful process completion and a consistent report with at least one passed test. Reports distinguish passed, failed, skipped and todo results. Each run replaces the previous report, including when it fails.

Gate reports and package verification share the source observer. It resolves the tree from the observed commit and checks HEAD again after reading working-tree status. If the checkout changes during observation, it records an unknown source and package verification stops at preflight.

The shareable summary is written to `.verification/package-e2e.json` and a JSON line in the CI log. It contains the commit/tree, clean/dirty state, artifact SHA256 and size, platform/architecture/Node, elapsed time and test counters. Detailed test logs are separate; review those for private data before sharing. Generated reports are Git-ignored local artifacts.

The local report describes a test build with `signed: false`, `published: false` and its observed clean/dirty state. Release preparation adds independent signature and asset verification. Track dependencies and generated inputs with their build records, and run one build at a time in each checkout.

## Check documentation and examples

`docs/current-facts.md` is generated from the package, protocol, MCP catalog, resource bindings and reviewed release state. `docs/tool-examples.md` comes from `docs/tool-examples.json`. The documentation check validates each example against its real Zod schema, including cross-field constraints, and checks expected rejection cases. Examples use synthetic commands, IDs and hashes; substitute values for your authorized environment when following a guide.

After changing a source contract or example, run `npm run generate:facts` and review the diff. Run `npm run check:docs` to validate the generated documents and registered examples. Review prose and any examples outside that registry against the relevant implementation as part of the change.

## Record release and deployment results separately

GitHub native jobs run domain/contract tests, Runner tests and applicable tooling on Linux, macOS and Windows. The full installed-package transport suite runs in the Linux verification jobs on GitHub and GitLab. Record platform-specific results and skips with their actual execution environment.

Collect separate records for signed release assets, deployed Worker/Runner behavior, account usage and MCP client catalog refresh. The local package report leaves these external checks as `not_run`. Attach each completed observation with its timestamp, exact version or commit, environment and result.

For release decisions, retain the exact commit, CI run, platform, skips and result for each required check. Use the [publication workflow](maintainers/release-process.md) for release requirements and [build provenance](build-provenance.md) to compare a deployed Worker with its source.
