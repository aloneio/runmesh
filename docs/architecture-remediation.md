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

`apps/worker/browser/admin-client.js` is the browser entry. Central product
modules live in `browser/central/`: `controller.js` owns busy state, write
admission and refresh snapshots; `api.js` owns HTTP receipts and pagination;
`services.js` and `skills.js` own their separate workflows; `view.js` owns
shared DOM primitives and `messages.js` owns central browser bilingual copy.
Workflow dependencies are injected by the controller, never imported from peers.
Architecture fixtures reject reverse imports and direct workflow network calls.

The controller supplies the mounted-view check and navigation port. Removed views
cannot consume late receipts, start follow-up requests or redirect the new page.
Already dispatched server operations may still complete; a new view reads current
state rather than replaying them. Receipts must match collection, item or mutation
operations; an unconfirmed write requires refresh before another mutation.

The generator bundles only local static JavaScript modules into one CSP-compatible
script. It bounds the input graph and output, rejects external/dynamic imports and
path/symlink escapes, checks syntax without executing DOM code, and atomically
writes the ignored Worker module during build, typecheck and Wrangler preparation.
Nonce/no-nonce hashes cover the reviewed bundled bytes; DOM tests cover behavior.

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

Job fault scenarios use the atomic-file port. Concurrency, enrollment-fence
recovery and reporting-bridge tests use RegistryRequestPort with real DO storage,
process execution, cancellation and observable-state assertions.

The three Runtime coordination races use an internal JobPersistencePort: fast-exit
durability, late running snapshot and spawn-setup/cancellation. The supplied
enqueue callback retains JobManager serialization and identity checks while
allowing pauses before enqueue or after coordinator completion. Production adds
no asynchronous boundary; the internal constructor overload is stripped from
package declarations. AR18 prohibits private persistence interception.

Child-exit-before-signal uses the file/process ports, observes the actual child
close event and checks durable terminal state and zero termination calls. The
retention fixture loads valid persisted records, creates running/queued Jobs via
public admission and verifies opt-in deletion while all four protected states
survive. Neither migrated test reads or mutates JobManager's private maps.

Registry route parsing lives in `registry/route-inputs.ts`; policy/workspace
and merged audit response projections live in `registry/route-projections.ts`.
These functions receive values and do not acquire state or perform I/O. RegistryDO
continues to own signed-request admission and transaction/nonce ordering. Registry
state owners retain identity and SQL authority; history coordinators recheck the
current lifecycle through owner ports after external reads. Pure and route regressions
preserve validation errors, status codes, projection fields and audit ordering.

Registry authorization route adapters live in registry/routes/: admin owns
administrator sessions and throttling, clients owns client settings and Runner
selection, runner-policy owns managed workspace and policy responses, and
identity owns MCP identity and authorization responses. Each receives its own
explicit synchronous operation port; none imports RegistryDO, domain owners,
storage, platform types or another adapter. RegistryDO wires these operations
and admits requests before invoking a route. There is no await between an
adapter's authority check and mutation. The architecture gate rejects reverse
dependencies, asynchronous adapters, scheduling and ambient network access.

Packed Job and external audit route regressions construct RegistryDO with the
real environment contract and a D1 binding, injecting failures at D1 preparation.
Transport tests use the Durable Object test callback's storage; schema tests call
the schema module. These tests no longer replace private environment/history
fields or read the private context. Archive opt-out, no-write cost checks,
degraded history and Runner availability assertions remain in place. The gate
also guards against reintroducing these retired private test seams.

Keep JobManager and RunnerDO as state owners. Run generated-source, contract,
dependency and fault regressions with the required package, native and browser
checks; record passes, skips and unexecuted environments for the candidate SHA.

## Native administration and browser composition

Runner creation, token registration, credential rotation/revocation, enrollment
regeneration, deletion and policy changes use contracts and explicit operation
ports. These application use cases return typed outcomes and cannot import
Worker transport, construct Request/Response, read platform globals or acquire
time/randomness. HTTP modules compose operations and translate outcomes; signed
RunnerDO mutation transport lives in platform/runner-mutations.ts. Mutation IDs,
commit evidence, uncertain-write handling and finalization remain one workflow.

Registry runner-lifecycle and runner-policy-read adapters are synchronous. Policy
revision evidence is queried once through RegistryPolicy.policyMutationId.
history-routes and transport-routes coordinate only their injected operations;
they do not own database bindings or import state owners. D1 history failures stay
explicit and never become a successful empty fallback. Request admission invokes
the matching coordinator directly, without a yield between authority and a
synchronous mutation. Alarm scheduling stays with RegistryDO.

The browser entry composes locale, clipboard, page-controls, admin-pages and
admin-navigation. Initial and mounted pages share one idempotent control binder.
Navigation has one instance-owned pending/queued state; readiness is projected
through data-runmesh-navigation and data-runmesh-navigation-busy on the document.
Tests import modules normally and inspect DOM behavior rather than slicing source
or depending on private window flags.

Runtime fault tests capture children at JobProcessPort, intercept file operations
at JobFilePort and load persisted recovery fixtures. Coordination timing uses
the internal JobPersistencePort. Completion and retained-record operations have scoped
ports in jobs/completion.ts and jobs/retention.ts; JobManager still exclusively
owns all maps, publication and process retirement. Synthetic replacement races
exercise those operations directly, with durable-write, event and retirement
assertions. Public JobManager tests retain actual child, cancellation, late-output
and restart coverage. Recovery concurrency tests now run across host platforms
using controlled process inspections rather than private maps or process.kill
interception; native process behavior remains covered separately.

Environment discovery lives in apps/runner/src/environment.ts; Runtime and CLI
consumers depend on environment-contracts.ts rather than the native probe class.
The packaged ESM/CJS consumers verify structural environment substitution.
domain/runner-handshake.ts owns pure hello negotiation, Registry receipt parsing
and welcome projection. RunnerDO retains sockets, epochs, admission and pending
RPC ownership, including replacement checks and synchronous dispatch ordering.
Architecture fixtures reject reverse imports, ambient state and scheduling in
these pure boundaries.
