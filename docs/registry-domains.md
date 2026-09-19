# Registry domain boundaries

Use this reference when changing Registry logic. All domain modules run within one Registry Durable Object and share its synchronous storage owner.

## Ownership

| Module | Responsibility |
| --- | --- |
| `registry.ts` | Public compatibility facade, DO construction/schema, HTTP routing, existing maintenance and external-history orchestration |
| `registry/auth.ts` | Administrator sessions, password-generation checks, throttle fallback, MCP credentials and sticky selection |
| `registry/policy.ts` | Current authorization decisions, permission intersections, workspace mutations, immutable policy versions and acknowledgement |
| `registry/lifecycle.ts` | Runner creation/enrollment, credential mutation receipts, connection epochs, heartbeat, revocation and identity-bound reads |
| `registry/history.ts` | Local metadata snapshots, monotonic Job updates, recording preferences at ingestion, read projections and audit retention |
| `registry/ports.ts` | Narrow collaboration signatures shared by domain implementations |
| `registry/storage.ts` | Direct access to the native SQL handle and synchronous transaction owner |
| `registry/records.ts`, `registry/values.ts` | Internal row/result shapes, fixed constants and existing value validation/projection |

The facade injects typed closures for each service's collaborators and performs initialization before use. Constructors only capture those dependencies. The lifecycle service receives the verifier pepper it needs; the policy service receives the history-backend selector. Keep the broader Worker environment and DO context at the facade.

The facade provides public signatures, route definitions and compatibility exports. Domain service methods support internal collaboration through typed ports.

## Transaction and authorization invariants

There is one Registry DO and one storage owner. `RegistryStorage.transactionSync` calls that owner's native synchronous transaction directly and returns its exact result or exception. Cross-domain calls through the typed ports remain synchronous. A lifecycle registration can create its policy snapshot inside the very same transaction: failure rolls back both the Runner and its mutation/policy rows.

A port invokes an operation with current authorization. Preserve its synchronous boundary and distinct results for authentication failure, unavailable dependencies, stale policy, invalid records and optional-history degradation. Keep storage initialization and supported migrations at DO startup.

SQL is grouped by business responsibility. Atomic operations such as deletion, credential replacement and recording-preference changes touch tables used by several domains. Keep those cross-table operations in the same synchronous transaction when reorganizing modules.

The facade owns HMAC/HTTP route ordering, DO bootstrap, maintenance scheduling, feature-health coordination and D1 boundary handling. Keep cross-domain transactions with that storage owner when changing module boundaries.

## Regression evidence

`test/registry-domains.test.ts` compares 40 deterministic operations against the unmodified baseline. Its golden fixture records ordered SQL/argument hashes, transaction begin/commit order, actual SQLite cursor rows read/written and public receipts. It covers session/password changes, nonce replay, Runner registration and retry, policy changes/acknowledgement, final authorization, heartbeat replay, Job snapshots and no-record mode, client rotation and revoked/stale transport. Fixture values are synthetic.

The same test injects a policy-storage exception during registration and verifies that Runner, credential-ledger and policy rows all roll back. Domain-boundary tests separately construct all four services with inaccessible collaborators, verify the synchronous storage adapter and exercise narrow SQL-only operations without a full DO fixture.

The original AR06 extraction was compared against `ca511cf0fa9411b85a52ba78547aeab7e4b27dec`. For each later change, run the affected credential, enrollment, scope, policy-generation, revocation, quota, hibernation, history and MCP integration regressions against the new candidate.

Both providers' architecture gate checks the dependency direction: domains use foundations and narrow ports; the facade composes domains with HTTP and external history adapters. Domain imports of the facade, concrete peers, MCP/UI handlers or external history adapters fail this check.

## Compatibility and resource use

For compatibility changes, compare query sequences, measured row counts and returned JSON. Measure account costs and production capacity in the target Cloudflare environment.

Before deployment or rollback, assess the storage compatibility of the complete target revision. Follow the [upgrade guide](upgrading.md) and preserve existing resources during module reorganizations.

Reference: Cloudflare's [SQLite-backed Durable Object storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) documents the synchronous transaction callback and rollback behavior retained by this adapter.
