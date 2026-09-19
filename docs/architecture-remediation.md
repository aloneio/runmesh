# Module ownership and regression checks

Use this reference when moving code between modules or changing an adapter. The
AR identifiers trace historical implementation stages. See the [Chinese version](architecture-remediation.zh-CN.md)
and the [upgrade guide](upgrading.md) for component deployment.

## Ownership

| Area | Owns | Dependencies to keep outside this layer |
| --- | --- | --- |
| Worker entry | Fetch/scheduled assembly and routing | Duplicated business decisions |
| HTTP | Parsing, authentication, CSRF, response representation | Registry implementation/record types |
| Application | Lifecycle/policy coordination and data projection | HTTP, views, concrete Registry facade |
| Contracts/domain | Stable types, ports, pure decisions | Platform or presentation implementations |
| MCP server | SDK assembly, reauthorization, output verification | Registry or RunnerDO classes |
| MCP results | Safe projection and bounded envelopes | Handlers, dispatch, audit, transport |
| Views | Synchronous rendering of explicit view models | Registry records or HTTP operations |
| Registry | Single authority/transaction owner | Presentation in domain modules |
| Runner coordinators | State transitions and side-effect ordering | Competing owners of the same state |

The executable matrix is in `scripts/architecture-policy.mjs`. It checks ordinary
and type imports, re-exports, literal dynamic imports and browser source. Register
new platform adapters explicitly. Unresolved/computed dependencies and runtime or
type-inclusive cycles fail. Negative fixtures cover reverse dependencies, facade
imports and renamed intermediary modules.

## Use cases and display models

`application/delete-runner.ts` owns the browser and administrator-token deletion
sequence: confirmation, one mutation ID, fencing, state observation, cancellation
and finalization. Each entrypoint authenticates its request before calling the use
case. Keep refusal, dependency failure and unknown effects distinct, and observe
an uncertain mutation before deciding whether to retry.

Registry owns HMAC routing and synchronous transactions; RunnerDO owns session
dispatch. `contracts/admin-views.ts` defines display shapes, and
`application/admin-projections.ts` selects permitted fields after authorization.
Keep credential verifiers in the authority layer. MCP workspace metadata omits
configured absolute roots; requested file contents and command output may contain
paths.

## Native adapters and package declarations

JobManager owns admission, maps, terminal persistence and cancellation/recovery
order. ContextStore owns shared serialization and intent/record/index ordering.
Inject file, process and repository faults through internal dependencies. Public
constructor signatures remain stable; declaration generation strips internal
overloads. `pack:smoke` compiles ESM and CommonJS consumers using the published
package declarations.

Systemd, launchd and Task Scheduler have separate adapters. CLI input, enrollment,
diagnosis and lifecycle commands have separate owners. Patch planning and Git
projection are separated from native execution, while their coordinators own the
complete operation. `registry/schema.ts` supplies DDL and checks at synchronous
Registry startup.

## Browser source and messages

Edit browser behavior in `apps/worker/browser/admin-client.js`. Its bounded
generator checks syntax and atomically writes the ignored Worker module during
build, typecheck and Wrangler preparation. Nonce/no-nonce rendering hashes cover
the original script bytes.

`i18n/messages.ts` owns stable bilingual IDs. `message()` accepts typed keys,
locales and key-specific parameters, with compiler regressions for invalid calls.
Use these keys for new copy and preserve them during wording changes. Named HTML
compatibility adapters retain digit spelling, escaping, language selection and
opaque-data exclusions.

## Verification and delivery

Vitest configurations declare roots and collection boundaries.
`check:verification` compares actual `vitest list` output against the manifest
from both repository and package directories. Missing, duplicate, external and
archived tests fail collection checks. Run the collected tests separately and
retain historical audit archives.

Baseline regressions cover all ten MCP tool schemas, descriptions and annotations,
plus wire-schema bytes. Run the affected authenticated Worker, race/recovery,
installed-package, native-platform and Chromium checks against the candidate SHA.

Development deploys to `runmeshdev`; production deploys to `runmesh`. With a
GitLab-connected Cloudflare build, fast-forward GitLab `dev` after that SHA passes
GitHub `verify-all`. Use the separately configured `sync-gitlab-dev.mjs` host
bridge or perform the fast-forward manually. Before upload, the wrapper checks
branch/environment, configuration and `WRANGLER_CI_OVERRIDE_NAME`, then supplies
the explicit Worker name. See [deployment](deployment.md). Development installation
requires a discoverable, verified immutable prerelease.

Retain compatibility facades and stateful coordinators while moving operations
behind narrower interfaces. Migrate white-box race tests only when the replacement
preserves fault timing and observable assertions.

## AR09–AR14: platform boundaries and failure seams

Implementation baseline: `1a05c4db85881ae80c2b8f0c11985ababeddc44f` (dev, 2026-09-16).

| Package | Implemented boundary | Preserved owner |
| --- | --- | --- |
| AR09 | External platform imports use Worker roles, including types; Node uses `isBuiltin`; supported extensions are canonicalized. New Job/Context files default to pure. | Reviewed platform adapters and source dependency checks |
| AR10 | Connection runtime/policy/transport ports; separate failure classification, metadata, policy candidate construction and Job frame projection | Connection owns socket identity, generation, desired/applied policy, timers and async ordering |
| AR11 | Context repository, Job atomic-file, Connection socket and Worker Registry/reply injection | Internal test interfaces retain crash, cancellation and outage assertions |
| AR12 | Optional feature-health store and pure maintenance decisions | RegistryDO owns transactions, cross-domain orchestration and alarms |
| AR13 | Pure log capacity, retention candidate selection and expiry decision | JobManager owns counters, record identities, persistence reservations, processes and deletion rechecks |
| AR14 | Registered test collection and bilingual ownership/verification documentation | Source, native-host, package, signed-release and live evidence are recorded separately |

Connection retains its public options and one-argument constructor; internal
overloads are stripped from published declarations. Worker transport uses signed
Registry requests. The reply mailbox has one owner and synchronous operations.
Keep the final local admission check and socket send in one synchronous section.

Feature-health construction captures dependencies. A failed optional SQL write
preserves the in-memory breaker, and RegistryDO schedules alarms using persisted
deadlines. Retention planning returns original record objects; the coordinator
checks identity and persistence state around deletion I/O.

Fault tests use injected ports in place of private connection, index, persistence
and waiter methods where timing is equivalent. The crash test exits a real child
process. Queue tests block persistence at the file adapter and cancel through
public Job APIs. Verification covers import fixtures, local workerd SQLite,
reply-socket ownership, retained-record identity and log capacity, alongside policy,
history, package and browser regressions.

## AR15-AR18: release contracts, explicit cache state and test isolation

Implementation baseline: `8ee90367db4db491faa6ebec79a866e81a52da61` (dev, 2026-09-17).

| Area | Owner | Contract |
| --- | --- | --- |
| Reviewed release constants and URLs | `domain/release-config.ts` | Reviewed version, key, origins, digests and size limits; installer compatibility exports |
| Signed-manifest fields | `domain/release-manifest.ts` | Import-free typed validation of consumed fields and canonical UTC dates; unconsumed signed extensions are tolerated |
| Installer verifier fields | `generate-release-validation.mjs` | Bounded syntax compilation and deterministic ignored output regenerated during build/typecheck preparation |
| Release/cache projection | `domain/release-selection.ts` | Pure value projection |
| Fetching, bounded reads and crypto | `distribution/release-io.ts` | Fixed origins, retry and byte limits; installer artifact size/hash/checksum verification |
| Request-owned discovery/refresh | `distribution/release.ts` | Explicit fetch, verifier, clock, cache and value-state ports |
| Isolate composition | `http/release-cache.ts` | Shared value cache and launch counters; pending I/O belongs to its request |

The same field validator is compiled into the POSIX and PowerShell verifier
bodies. Signed-fixture differential tests execute Worker verification and both
generated bodies. Native platform jobs cover host-specific behavior.

Cache reads and failed refreshes recheck the current value after asynchronous
work. A newer committed refresh takes precedence over a delayed older result.
Only successful verification updates its timestamp, and soft reuse stays within
the original one-hour expiry. Stable selection is source-pinned; development
selects its verified dev channel.

New Job, Context, Patch and Connection files default to the pure role. Register
I/O adapters explicitly; reviewed hash/path calculations and platform type ports
have named exceptions. Patch contracts use `path-contracts.ts` while preserving
the `PathSnapshot` compatibility export and resolved-path shape.

Eight Job fault scenarios use the atomic-file port. Concurrency, enrollment-fence
recovery and reporting-bridge tests use RegistryRequestPort with real DO storage,
process execution, cancellation and observable-state assertions.

Four Runtime tests retain private persistence-coordinator interception to preserve
specific timing: fast-exit durability, late running snapshot, spawn-setup/cancellation
and child-exit-before-signal. The architecture regression guards these names.
Replace an exception only after demonstrating equivalent timing and assertions.

Keep JobManager and RunnerDO as state owners. Run generated-source, contract,
dependency and fault regressions with the required package, native and browser
checks; record passes, skips and unexecuted environments for the candidate SHA.
