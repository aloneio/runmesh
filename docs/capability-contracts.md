# Capability contracts and on-demand diagnostics

This is a source slice of review packages **R01 / R07**, based on development commit `b1b2dbed1a35e68322d678ba3f540cc114d5ed4a`. Source verification is not production deployment or a signed Runner release.

## One protected operation definition

`packages/protocol/src/operations.ts` defines the existing 25 protected RPC methods, independent MCP scopes and workspace permissions, Job checks, and which local read results require a final policy-generation check. The wire enum, Registry adapter, Runner advertisement and read-completion checks consume it. Unknown methods have no grant; prototype property names cannot inherit one. `echo` and `runner.info` retain their separate transport treatment.

`apps/worker/src/mcp/actions.ts` maps 24 Runner-backed actions onto those methods. The public surface stays at 10 tools. Selection and workspace-list operations retain their existing control-plane paths. Inspect, file read, edit, shell, Job and Context handlers use the map instead of choosing method strings independently. Current principal, workspace, policy, session and Job checks remain authoritative at dispatch.

This slice does not replace every permissive output schema, generate all handlers, add deployment capability switches or change pagination. Those R07 requirements remain open.

## Three separate facts

`inspect action=diagnostics` reuses the existing single `env.info` RPC. New Runners add a strict, bounded `runtime_capabilities` report: version, operation-contract hash, supported methods, feature protocol versions and concurrency limit. It contains no hostname, service identity, root path, credential or environment values.

| Field | Meaning |
| --- | --- |
| `runner_support` | The authenticated peer reports implementation, not proof of OS access or external dependencies |
| `permission_snapshot` | The revalidated scopes and returned effective permission bit permit or deny at observation time; not a later execution grant |
| `requires_final_authorization` | Always true; actual calls must pass current authorization again |
| `requires_job_check` | The existing Job/workspace authorization is also required |
| `host_catalog_state` | Always `not_observed`; the Worker cannot read a host application's private tool cache |

Old Runners can remain reachable without this report. Omission is `not_reported`, malformed/unsupported reports are `invalid`, and support remains `unknown`. Capabilities are never inferred from a version label. A valid partial list can report individual methods as unsupported. A mismatch does not authorize, upgrade, reconnect or re-register a machine.

Reports are peer observations, not signed build attestation. A contract hash is not a source commit. Permissions may change during/after diagnostic awaits; final dispatch checks remain necessary. Existing safe shell-availability fields remain separate.

## Detecting stale tool directories

`/health` includes `mcp_catalog`: schema version, canonical SHA-256, tool names/count, action count and operation hash. Each `tools/list` tool carries the compact fingerprint in `_meta["io.runmesh/catalog"]`; diagnostics includes the full summary. It covers emitted input/output JSON schemas, descriptions, annotations, scopes and action mappings, not source code, timestamps, runtime grants or cross-field refinements that JSON Schema cannot express.

Compare the actual authenticated tools/list, health summary and host-registered inputs. Hosts may ignore metadata or cache older schemas. Matching server hashes do not prove host refresh. Refresh only the affected connector; do not regenerate credentials to update its cache. The MCP endpoint is secret-bearing: never publish its raw URL or authorization headers.

Real-transport tests compare every advertised schema, description, annotation and fingerprint with the source contract, rather than just counting names. Clients that ignore `_meta` retain the existing tool surface.

## Resource and privacy boundaries

The hash is calculated once per Worker isolate with no storage, timer or subscription. Public health works with unavailable Registry, Runner and D1 bindings. Diagnostics adds no RPC beyond existing env.info and no Job/audit history row; existing authorization traffic still has cost.

Runner reports reuse the existing cached executable probes, adding no shell command or filesystem persistence. Tests repeat 100 reports and check eight initial existing probes, no created state directory and a report below 2 KiB. The diagnostic fixture stays below 16 KiB. These are local scenario bounds, not account-wide billing results.

## Compatibility and delivery

No strict wire-envelope field or database schema is added. The optional report is inside the already JSON-valued env.info result. Published v0.1.3 does not retroactively gain it; a future verified Runner release is required. A new Worker with an old Runner reports unknown, not revoked credentials.

This batch is delivered through dev. Production main, current secrets, Worker/D1/DO identities and the running maintenance service are preserved. Exact production source provenance, host refresh, R06 provider measurements and remaining R07 output/pagination work are not completed by this slice.
