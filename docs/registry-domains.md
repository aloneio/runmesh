# Registry domain boundaries

Use this reference when changing Registry logic. The domain modules share one Registry Durable Object and synchronous storage owner; they are not separate databases or network services.

## Ownership

| Module | Responsibility |
| --- | --- |
| `registry.ts` | Public compatibility facade, DO construction/schema, HTTP routing, existing maintenance and external-history orchestration |
| `registry/auth.ts` | Administrator sessions, password-generation checks, throttle fallback, MCP credentials and sticky selection |
| `registry/policy.ts` | Current authorization decisions, permission intersections, workspace mutations, immutable policy versions and acknowledgement |
| `registry/lifecycle.ts` | Runner creation/enrollment, credential mutation receipts, connection epochs, heartbeat, revocation and identity-bound reads |
| `registry/history.ts` | Local metadata snapshots, monotonic Job updates, recording preferences at ingestion, read projections and audit retention |
| `registry/ports.ts` | Narrow collaboration signatures, with no dependency on a DO or concrete peer implementation |
| `registry/storage.ts` | Access to the same native SQL handle and synchronous transaction owner; no batching, retries, cache or Promise conversion |
| `registry/records.ts`, `registry/values.ts` | Internal row/result shapes, fixed constants and existing value validation/projection |

The facade wires typed closures for only the collaborators each service needs. A service is not given the full Registry, Worker environment, DO context or a peer service. Each constructor is inert: no SQL, network request, schema creation, alarm or credential discovery. The lifecycle service receives only the existing verifier pepper value it needs; the policy service receives only the existing history-backend selector.

The facade provides the public signatures and compatibility exports. Methods used by other internal domains are accessible on service classes but are not HTTP routes or RPC methods.

## Transaction and authorization invariants

There is one Registry DO and one storage owner. `RegistryStorage.transactionSync` calls that owner's native synchronous transaction directly and returns its exact result or exception. Cross-domain calls through the typed ports remain synchronous. A lifecycle registration can create its policy snapshot inside the very same transaction: failure rolls back both the Runner and its mutation/policy rows.

A port is an operation, not a cached permission snapshot. Preserve the synchronous authorization boundary and distinguish authentication failures, unavailable dependencies, stale policy, invalid records and optional-history degradation. Domain service constructors do not repair or migrate stored values.

SQL is grouped by business responsibility, not placed behind a generic asynchronous repository abstraction. Some original atomic operations necessarily touch tables also read by another domain, for example deletion, credential replacement and recording preferences. Those transaction boundaries are intentionally retained. This is not a claim of disjoint table ownership or a completed rewrite of every SQL use into a pure domain model.

The facade owns HMAC/HTTP route ordering, DO bootstrap, maintenance scheduling, feature-health coordination and D1 boundary handling. Keep cross-domain transactions with that storage owner when changing module boundaries.

## Regression evidence

`test/registry-domains.test.ts` compares 40 deterministic operations against the unmodified baseline. Its golden fixture records ordered SQL/argument hashes, transaction begin/commit order, actual SQLite cursor rows read/written and public receipts. It covers session/password changes, nonce replay, Runner registration and retry, policy changes/acknowledgement, final authorization, heartbeat replay, Job snapshots and no-record mode, client rotation and revoked/stale transport. Fixture values are synthetic.

The same test injects a policy-storage exception during registration and verifies that Runner, credential-ledger and policy rows all roll back. Domain-boundary tests separately construct all four services with inaccessible collaborators, verify the synchronous storage adapter and exercise narrow SQL-only operations without a full DO fixture.

Run the credential, enrollment, scope, policy-generation, revocation, quota, hibernation, history and MCP integration regressions for relevant changes. The original AR06 extraction was compared against `ca511cf0fa9411b85a52ba78547aeab7e4b27dec`; that historical comparison does not verify subsequent code changes.

Architecture checks reject domain imports of the Registry facade, concrete peer services, MCP/UI handlers or external history adapters. Foundations cannot import domain implementations. These checks use the already-required GitHub and GitLab architecture gate; no new runtime dependency is added.

## Compatibility and resource use

For compatibility changes, check query sequences and measured row counts as well as returned JSON. Ordinary SQL and authentication consume resources; local fixtures do not establish account-wide costs or production capacity.

Before deployment or rollback, assess the storage compatibility of the complete target revision. Follow the [upgrade guide](upgrading.md) and preserve existing resources; a module reorganization alone is not a reason to reset storage.

Reference: Cloudflare's [SQLite-backed Durable Object storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) documents the synchronous transaction callback and rollback behavior retained by this adapter.
