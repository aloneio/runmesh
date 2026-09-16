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

Development targets `runmeshdev`, production `runmesh`. The oci0 `runmesh-dev-sync.timer` observes GitHub `dev`; after the exact SHA receives the mandatory `verify-all` success, it fast-forwards GitLab `dev`, whose push remains the Cloudflare Workers Builds trigger. Synchronization is fast-forward-only, runs under the existing unprivileged host account, and does not copy a cross-provider token into repository CI. Before uploading, the deployment wrapper checks the config and `WRANGLER_CI_OVERRIDE_NAME` against the branch/environment target and passes an explicit Worker name. Development may expose the independently reviewed signed stable Runner for one-command enrollment; it never publishes unsigned branch bytes as a Runner release. Main promotion, live acceptance and immutable signed publication remain separate actions.

Compatibility facades, bounded legacy localization and stateful coordinators are intentional. Existing white-box race tests should migrate to supported failure seams gradually, not be removed to make a refactor green. File-size reduction alone is not an acceptance criterion.
