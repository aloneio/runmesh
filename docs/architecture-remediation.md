# Modular architecture remediation

This is a source-maintenance contract, not evidence that a Worker or installed Runner has been upgraded. It extends AR01-AR08 without adding runtime dependencies, permission scopes, services, storage migrations or automatic upgrades. See the [Chinese version](architecture-remediation.zh-CN.md).

## Ownership

| Area | Owns | Must not import |
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

The role matrix in `scripts/architecture-policy.mjs` is executable. Unknown Worker modules are not implicitly trusted foundations. Ordinary/type imports, re-exports, literal dynamic imports and browser source are checked. Computed/unresolved source dependencies and both runtime/type-inclusive cycles fail. Negative fixtures cover reverse dependencies, facade imports and a renamed intermediary.

## Use cases and display models

`apps/worker/src/application/delete-runner.ts` is the single deletion sequence for browser and administrator-token entrypoints. Request-local ports preserve confirmation, one mutation ID, fencing, state observation, cancellation and finalization order. Refusal, dependency failure and unknown effects remain distinct; no uncertain mutation is automatically retried. Authentication remains at the original entry boundaries.

Other lifecycle/policy coordination is extracted from the Worker entry. Registry HMAC routing and RunnerDO session dispatch deliberately retain their consistency owners. `contracts/admin-views.ts` owns presentation shapes; `application/admin-projections.ts` explicitly selects fields. Detailed data is projected after authorization. Credential verifiers are not display data, and authorized workspace roots never enter public MCP output.

## Native adapters and package declarations

JobManager retains admission, maps, terminal persistence and cancellation/recovery order. ContextStore retains shared serialization and intent/record/index ordering. Trusted internal dependencies permit file/process/repository failure injection, not new CLI/RPC settings. Internal overloads are stripped from published declarations; original constructor signatures remain. `pack:smoke` checks ESM and CommonJS consumers without requiring `@types/node` or an unpublished workspace package.

Systemd, launchd and Task Scheduler adapters are separate from the service facade. CLI input, enrollment, diagnosis and lifecycle commands have separate owners. Patch planning and Git projection are separated from file/native execution; the original coordinators still own complete operations. Registry DDL and schema checks live in `registry/schema.ts` and are invoked at the original synchronous startup boundary. Namespace, database and secret identities remain unchanged.

## Browser and language

`apps/worker/browser/admin-client.js` is independently authored browser source. Its bounded generator syntax-checks without execution and atomically produces an ignored Worker module. Build/typecheck and the Wrangler preparation hook generate it. Nonce/no-nonce rendering hashes preserve the original script bytes.

`i18n/messages.ts` owns stable bilingual IDs. `message()` accepts typed keys/locales, not user labels. Formatted messages have key-specific parameter types and literal substitution; a real compiler regression checks invalid calls. Existing HTML localization remains in named compatibility adapters, preserving digit spelling, escaping, language selection and opaque data exclusions. New copy uses keys; copy edits do not rename keys or remove compatibility protections.

## Verification and delivery

All Vitest configs declare roots and collection boundaries. `check:verification` compares actual `vitest list` output with the manifest from both repository and package directories. Missing, duplicate, external and archived tests fail. Collection is not test execution evidence; audit archives remain preserved.

The baseline regression covers all ten MCP tool schemas/descriptions/annotations and wire-schema bytes. Authenticated Worker, race/recovery, installed-package and actual Chromium tests remain required. Linux evidence is not native Windows/macOS or hosted-provider verification.

Development targets `runmeshdev`, production `runmesh`. The oci0 `runmesh-dev-sync.timer` observes GitHub `dev`; after the exact SHA receives the mandatory `verify-all` success, it fast-forwards GitLab `dev`, whose push remains the Cloudflare Workers Builds trigger. Synchronization is fast-forward-only, runs under the existing unprivileged host account, and does not copy a cross-provider token into repository CI. Before uploading, the deployment wrapper checks the config and `WRANGLER_CI_OVERRIDE_NAME` against the branch/environment target and passes an explicit Worker name. Development exposes only an immutable signed dev prerelease for one-command enrollment and fails closed when none is discoverable; it never falls back to the stable Runner or publishes unsigned branch bytes as a Runner release. Main promotion, live acceptance and immutable signed publication remain separate actions.

Compatibility facades, bounded legacy localization and stateful coordinators are intentional. Existing white-box race tests should migrate to supported failure seams gradually, not be removed to make a refactor green. File-size reduction alone is not an acceptance criterion.

## AR09–AR14: platform boundaries and failure seams

Implementation baseline: `1a05c4db85881ae80c2b8f0c11985ababeddc44f` (dev, 2026-09-16). This section describes source ownership, not an installed Runner or live deployment.

| Package | Implemented boundary | Invariant |
| --- | --- | --- |
| AR09 | External platform imports use Worker roles, including types. Node built-ins use `isBuiltin`; supported extensions are canonicalized before and after resolution. New Job/Context files default to pure unless explicitly reviewed as adapters. | The source gate is not a sandbox, global-effect analysis or dependency-internals audit. |
| AR10 | Connection runtime/policy/transport ports; separate failure classification, metadata, policy candidate construction and Job frame projection. | The connection retains socket identity, generation, desired/applied policy, timers and async ordering; no competing session owner. |
| AR11 | Context repository, Job atomic-file, Connection socket and Worker Registry/reply injection. | Existing crash, cancellation and outage assertions remain; interfaces are internal, never RPC/CLI/configuration hooks. |
| AR12 | Optional feature-health store and pure maintenance decisions. | RegistryDO retains synchronous transactions, cross-domain orchestration and alarm scheduling. |
| AR13 | Pure Job log capacity, retention candidate selection and expiry decision. | JobManager retains all counters, original record identities, persistence reservations, process ownership and deletion rechecks. |
| AR14 | Registered test collection and bilingual ownership/verification documentation. | Source, native-host, installed-package, signed-release and live checks are distinct evidence. |

Connection's original public options and one-argument constructor remain available. Its narrow internal constructor overload is stripped from published declarations; no new configurable adapter selection is exposed. Worker transports default to the exact existing signed Registry request. The reply mailbox has one owner and synchronous operations: request deadlines remain in the original dispatch location, and nothing adds an `await` between the final local admission fence and socket send.

The feature-health store performs no I/O on construction. A failed optional SQL write still preserves the in-memory breaker; only RegistryDO decides when to schedule an alarm. Maintenance uses the existing persisted deadlines and SQL, without a new table, cache, retry loop or remote service. Retention planning returns the original record objects, not a deletion grant; the coordinator still checks identity and persistence state around I/O.

Fault regression tests now exercise the public methods of explicitly injected internal ports rather than replacing `connectOnce`, `ContextStore.writeIndex`, `JobManager.persist` or the DO's private waiter map. Some pre-existing white-box state/race tests deliberately remain; this is not a claim that all assertions or casts were removed. The original crash process actually exits, and queue persistence is blocked at the file adapter while cancellation is exercised through public Job APIs.

Verification includes positive/negative import fixtures, real local workerd SQLite adapter tests, reply socket ownership, retained-record identity and bounded log capacity, alongside the existing outage, policy race, no-record history, package and browser suites. Test collection is not execution evidence. CI results must refer to the exact candidate SHA; a previously passing dev commit does not verify these changes. No new runtime dependency, timer, mandatory setting, cloud resource, protocol version or storage format is introduced. Main promotion, production deployment, credential changes and installed Runner upgrades remain outside this refactor.

## AR15-AR18: release contracts, explicit cache state and test isolation

Implementation baseline: `8ee90367db4db491faa6ebec79a866e81a52da61` (dev, 2026-09-17).
This section records source ownership, not production deployment or installed Runner acceptance.

| Area | Owner | Preserved boundary |
| --- | --- | --- |
| Reviewed release constants and URL construction | `domain/release-config.ts` | Same reviewed version, public key, origins, digests and size limits; installer compatibility exports remain. |
| Consumed signed-manifest fields | `domain/release-manifest.ts` | Pure import-free TypeScript, canonical real UTC dates and typed fields; unknown unconsumed signed fields remain tolerated. |
| Installer verifier field code | `generate-release-validation.mjs` | Bounded syntax compilation, no input evaluation; deterministic ignored output, regenerated by the existing build/typecheck preparation. |
| Release and cache-record projection | `domain/release-selection.ts` | No fetch, cache storage or installer-template dependency. |
| Release fetching, bounded bytes and platform crypto | `distribution/release-io.ts` | Fixed origins, retry and byte limits; the installer still independently verifies artifact size, hash and checksums. |
| Request-owned discovery/refresh | `distribution/release.ts` | Explicit fetch, verifier, clock, cache and value-state ports; no function-identity-based test bypass. |
| Isolate runtime composition | `http/release-cache.ts` | One value cache and launch counters; no cross-request pending I/O promise. |

The same pure field validator is compiled into the actual POSIX and PowerShell verifier bodies. Signed-fixture differential tests exercise Worker verification and both generated bodies, not just copied predicates or string matches. This does not claim that Windows service installation ran on a Linux host.

Every cache read and failed refresh rechecks the current runtime value after the asynchronous boundary. A delayed old refresh cannot overwrite a newer committed refresh; failed refreshes do not advance the original verification timestamp. Soft reuse remains bounded by the original one-hour hard expiry. The complete network refresh retains its existing budget, and expired/future-dated values are never advertised as an outage fallback. Stable remains source-pinned and network-free; development never falls back to stable.

New Job, Context, Patch and Connection internal files default to the no-I/O role unless explicitly registered as adapters. Pure hash/path calculations and platform type ports have reviewed exceptions. Patch data contracts depend on `path-contracts.ts`, not `ReturnType` of the concrete PathPolicy class. The old `PathSnapshot` export and resolved-path shape remain compatible. This is a dependency guard, not a sandbox or a claim to analyze arbitrary global effects.

Eight Job fault scenarios now inject the existing atomic-file port. Concurrency, enrollment-fence recovery and reporting-bridge tests inject the existing RegistryRequestPort instead of replacing the private request method. They retain real DO storage, process execution, cancellation and observable-state assertions. No new production test hook or public configuration is added.

Four Runtime tests intentionally retain private persistence-coordinator interception because their pre-enqueue/post-coordinator ordering is not equivalent to a file-write fault: fast-exit durability, late running snapshot, spawn-setup/cancellation and child-exit-before-signal. These names are explicitly guarded by the architecture regression. Other state-machine white-box assertions are not claimed to be eliminated. Retiring an exception requires equivalent fault timing and assertions, not deleting a failing test.

JobManager and RunnerDO remain the original state owners. Neither receives a production-method change in this batch. Generated-source, contract, dependency and fault regressions must run alongside full ordinary CI, installed-package and native/browser checks. Same-SHA results, skips and unexecuted environments are recorded separately; an earlier passing commit is not acceptance evidence for this one.
