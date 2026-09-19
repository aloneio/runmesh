# Check Runner capabilities and tool catalogs

Use `inspect` with `action=diagnostics` to check what the connected Runner reports and what your current permissions allow. The extended capability report is implemented in the **0.1.4 candidate**. An installed v0.1.3 Runner can remain connected while reporting these capabilities as unknown.

## Available operations

The current catalog has 10 public tools and 26 Runner-backed actions. The shared protocol defines 27 protected RPC methods, including the internal workspace-list method. A method appearing in the catalog does not mean your selected Runner implements it or that your client may call it.

Every call must satisfy its explicit MCP scope, workspace permissions and current Runner policy. Job operations also check the actual Job workspace. Selection and workspace metadata queries use the control plane; live file, execution and Context operations require a usable Runner connection.

## Interpret diagnostic fields

The `runtime_capabilities` report includes the Runner version, operation-contract hash, supported methods, feature protocol versions and concurrency limit. It contains no hostname, service identity, root path, credential or environment values.

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

Clients that ignore `_meta` can still use the tools, but cannot use that metadata to diagnose a stale catalog.

## Resource and privacy boundaries

The hash is calculated once per Worker isolate with no storage, timer or subscription. Public health works with unavailable Registry, Runner and D1 bindings. Diagnostics adds no RPC beyond existing env.info and no Job/audit history row; existing authorization traffic still has cost.

Runner reports reuse cached executable probes. Diagnostics does not install dependencies, change permissions or write a Runner profile.

## Upgrade compatibility

Updating the Worker does not upgrade the Runner or refresh your MCP client's catalog. Install a verified Runner release containing the feature and refresh the affected connector when its catalog is stale.

For `context.storage` and `context.prune`, the Worker also checks the methods advertised by the current authenticated Runner connection before sending a request. Missing support returns `runner_upgrade_required` with `operation_state=not_started` and leaves the old connection usable. This compatibility check does not replace authorization.
