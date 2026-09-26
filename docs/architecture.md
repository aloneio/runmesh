# Runmesh architecture

Use this reference to locate the owner of a behavior before changing it. It describes the current source checkout. [Current facts](current-facts.md) and [tool examples](tool-examples.md) are checked by `check:docs`; [verification layers](verification.md) explains how to validate a change.

## Deployment and authority

The Worker provides the public MCP and browser endpoints. Each Runner connects outbound over WSS and owns local processes, files, Git operations, retained logs and Context records.

RegistryDOv2 owns identities, permissions, enrollment and policy authority in one SQLite-backed Durable Object. RunnerDOv2 owns each Runner's authenticated transport, connection generations and policy checks. Production's separate `HISTORY_DB` D1 binding stores optional audit metadata and packed Job snapshots. Treat a history outage as an optional-feature failure while preserving core credentials and authorization.

Each MCP client has an independently revocable secret URL and a persisted Runner selection. Switching an existing selection requires confirmation. If that Runner is unavailable, report its state and let the client choose another. Authorized clients selecting the same Runner can share workspace Jobs. Capabilities identify supported operations; current policy determines which operations a client may perform.

## Module ownership

| Area | Modules | Responsibility |
| --- | --- | --- |
| HTTP composition | `apps/worker/src/index.ts`, `apps/worker/src/http/` | Entry assembly, routing, request/response handling and session protection |
| Application use cases | `apps/worker/src/application/` | Shared lifecycle/policy coordination, Runner deletion and display projections |
| Presentation | `apps/worker/src/admin/`, `apps/worker/src/i18n/` | View/message contracts and rendering; Jobs and logs load on request |
| MCP | `apps/worker/src/mcp/` | Catalog, handlers, output validation, bounded projection and reauthorization |
| Foundations | `public-origin.ts`, `platform/env.ts`, `contracts/` | Origin rules, platform types and narrow application contracts |
| Registry domains | `registry/auth.ts`, `policy.ts`, `lifecycle.ts`, `history.ts` | Business operations over shared synchronous storage |
| Registry facade | `registry.ts` | Public compatibility API, schema startup, HTTP/HMAC, maintenance and external history |
| Runner composition | `apps/runner/src/runtime.ts` | Policy and service assembly |
| Job adapters | `apps/runner/src/jobs/` | File, process, log and recovery operations; JobManager coordinates lifecycle |
| Context adapters | `apps/runner/src/context/` | Storage/recovery and retention planning; execution revalidates paths and authorization |
| Shared protocol | `packages/protocol/src/` | Wire contracts, permissions, operation requirements, pagination and failure metadata |

Cross-table transactions remain within one Registry. The dependency gate checks application, domain and foundation imports in both CI systems, reporting runtime and type-inclusive cycles separately. See [module boundaries](architecture-remediation.md) for the role matrix and compatibility interfaces.

Managed MCP account connections follow the same boundaries.
`application/connectors/managed-oauth.ts` owns session authorization, state claims,
refresh ordering and credential leases. Its repository, cipher and protocol ports
live in `contracts/managed-oauth.ts` and contain no SDK or SQLite types.
`platform/connectors/managed-oauth.ts` adapts discovery, registration and tokens
to the MCP SDK; `managed-oauth-http.ts` bounds public network requests;
`managed-store.ts` owns synchronous SQLite persistence. Only `capabilities-do.ts`
assembles them. Architecture fixtures reject SDK imports in these contracts,
concrete adapter imports in use cases and storage/cipher ownership in the SDK adapter.
The control-panel renderer receives explicit display inputs and does not load
vault keys or compute unused endpoint-allowlist readiness.

## Authorization and state changes

Authenticate each entrypoint and reauthorize protected operations against current policy. Preserve distinct outcomes for a denied request, an unavailable dependency and malformed evidence. RunnerDO's final local policy check and socket send form one synchronous section. Queued Jobs reauthorize immediately before starting.

Registry SQL and transaction callbacks are synchronous. Registration and its initial policy snapshot share a transaction and rollback together. Keep that ownership when extracting a domain or storage adapter. Optional audit writes have their own outcome alongside the operation being recorded.

Jobs persist across MCP response closure and ordinary transport disconnection. After an uncertain result, inspect the original Job and process state before retrying. Cancellation and stdin delivery require the same care because the process may already have received them. Context cleanup uses an explicit preview followed by verification of the current plan.

## Installation and compatibility

Production uses independent, stable `INTERNAL_CONTROL_SECRET` and `RUNNER_TOKEN_PEPPER` values. `ADMIN_TOKEN` supports the optional programmatic administration API. The public origin comes from a validated routed HTTPS request, with a proxy override when needed. Hosted installation uses the reviewed release record, fixed artifact URLs and signature checks. See [runtime configuration](runtime-config.md) and [portable installation](portable-runner-installation.md).

During normal updates, preserve Worker names, v2 namespaces, D1 bindings, credentials and registered services. Investigate incompatible schemas against the target revision and use the [upgrade guide](upgrading.md). The [legacy migration](migration.md) procedure applies to its named pre-v2 boundary.

New Runners default to `dedicated_user`; privileged host execution requires an explicit choice. New MCP clients default to `coding:read`. First administrator setup uses CSRF, same-origin and atomic first-success-wins checks; initialize the instance before opening it to untrusted visitors. Shell processes run with the service account's operating-system privileges, so workspace policy must be paired with appropriate host permissions.

Retained logs and Context records remain on the Runner and are relayed when authorized clients request them. Cloud history holds bounded metadata. Recording preferences govern optional uploads; authorization records remain required. Snapshot, cursor and cleanup operations each have byte, count and time budgets.

## Validate a change

Choose the checks that cover the affected owner: pure rules, adapter/schema contracts, Runner integration, local Cloudflare integration, source transport or installed-package transport. Record native-platform, signed-release and live-environment results against the same candidate SHA. Use `not_run` for environments that have not been exercised.

For deployment acceptance, verify the compiled Worker commit, installed Runner version, client tool catalog and required account behavior. Measure Cloudflare cost and hibernation in the target environment. Stateful coordinators and compatibility interfaces have dedicated regression coverage; preserve it while moving operations behind narrower interfaces.
