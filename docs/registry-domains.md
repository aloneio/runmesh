# Registry domain boundaries (AR06)

Development refactor based on `ca511cf0fa9411b85a52ba78547aeab7e4b27dec`. This is an internal Worker change, not a new Durable Object, database migration, Runner upgrade or production activation.

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

The four extraction commits retain the original method bodies, parameters, result types and async markers. The facade keeps its existing public signatures and exports, so callers and platform bindings do not have to migrate together. Methods used by other internal domains are accessible on service classes but are not new HTTP routes or RPC methods.

## Transaction and authorization invariants

There is one Registry DO and one storage owner. `RegistryStorage.transactionSync` calls that owner's native synchronous transaction directly and returns its exact result or exception. Cross-domain calls through the typed ports remain synchronous. A lifecycle registration can create its policy snapshot inside the very same transaction: failure rolls back both the Runner and its mutation/policy rows.

No remote call, timer, retry or `await` is added to the final authorization chain. A port is an operation, not a cached permission snapshot. Authentication failures, unavailable dependencies, stale policy, invalid records and optional-history degradation retain their pre-refactor behavior. No stored value is repaired or migrated as part of construction.

SQL is grouped by business responsibility, not placed behind a generic asynchronous repository abstraction. Some original atomic operations necessarily touch tables also read by another domain, for example deletion, credential replacement and recording preferences. Those transaction boundaries are intentionally retained. This is not a claim of disjoint table ownership or a completed rewrite of every SQL use into a pure domain model.

The facade still owns the existing HMAC/HTTP route ordering, DO bootstrap, maintenance queue, feature circuit state and D1 boundary handling. Moving those independently can be reviewed later; this change does not disguise them inside another giant service or split them into remotely called microservices.

## Regression evidence

`test/registry-domains.test.ts` compares 40 deterministic operations against the unmodified baseline. Its golden fixture records ordered SQL/argument hashes, transaction begin/commit order, actual SQLite cursor rows read/written and public receipts. It covers session/password changes, nonce replay, Runner registration and retry, policy changes/acknowledgement, final authorization, heartbeat replay, Job snapshots and no-record mode, client rotation and revoked/stale transport. Fixture values are synthetic.

The same test injects a policy-storage exception during registration and verifies that Runner, credential-ledger and policy rows all roll back. Domain-boundary tests separately construct all four services with inaccessible collaborators, verify the synchronous storage adapter and exercise narrow SQL-only operations without a full DO fixture.

Existing credential, enrollment, scope, policy-generation, revocation, quota, hibernation, history ordering and MCP integration tests remain in place. Local structural comparison verifies all 98 moved method bodies after only the declared receiver rewrites, the 82 public method names (including the constructor), all 152 SQL call sites, and the 22 relocated transaction callbacks. It does not claim those methods are now behaviorally correct for every possible input; it establishes that this refactor did not silently change their existing logic.

Architecture checks reject domain imports of the Registry facade, concrete peer services, MCP/UI handlers or external history adapters. Foundations cannot import domain implementations. These checks use the already-required GitHub and GitLab architecture gate; no new runtime dependency is added.

## Cost, compatibility and rollout

The fixed comparison scenarios must keep their query sequence and measured row counts, not merely return matching JSON. There are no new runtime variables, DO namespaces, database tables/indexes, durable writes, recurring timers, RPCs or cloud services. Ordinary native SQL and existing authentication still consume resources; this is not an account-level zero-cost claim or a production load measurement.

The wire catalog, production Wrangler bindings, signed release assets and Runner source are unchanged. Development CI success is not production activation. Promote only through the existing reviewed main/deployment process. Because this refactor changes no stored format, reverting its Worker source does not require a data rollback; unrelated subsequent changes must still be assessed separately.

Reference: Cloudflare's [SQLite-backed Durable Object storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) documents the synchronous transaction callback and rollback behavior retained by this adapter.
