# Check Runner capabilities and tool catalogs

Use `inspect` with `action=diagnostics` and a readable `workspace_id` to check Runner support, current permissions and the server's tool catalog. The extended capability report is part of the **0.1.4 candidate**; v0.1.3 Runners report these capabilities as unknown until upgraded.

## Interpret the report

`runtime_capabilities` includes the Runner version, operation-contract hash, supported methods, feature protocol versions and concurrency limit. The report exposes capability metadata while keeping host identity, absolute paths, credentials and environment values private.

| Field | Meaning |
| --- | --- |
| `runner_support` | Implementation support advertised by the authenticated Runner; OS access and dependencies are checked when used |
| `permission_snapshot` | Scopes and effective workspace permission observed during this diagnostic |
| `requires_final_authorization` | `true`: each operation checks current authorization again |
| `requires_job_check` | The action also checks the actual Job workspace |
| `host_catalog_state` | `not_observed`: check the catalog loaded by your MCP application separately |

A missing report is `not_reported`; malformed or unsupported reports are `invalid`. Both leave method support `unknown`. A valid partial list can identify unsupported methods. Use the reported method list for capability decisions and a verified release artifact for build provenance; a version label or contract hash serves a different purpose.

The catalog contains 10 public tools, 26 Runner-backed actions and 27 protected RPC methods, including the internal workspace-list method. Each operation requires its own scope, current policy and workspace permission. Live file, execution and Context operations also require an available Runner connection.

## Check a stale connector catalog

`/health` exposes `mcp_catalog` with the schema version, SHA-256 fingerprint, tool names/count, action count and operation hash. Each `tools/list` entry carries the compact fingerprint in `_meta["io.runmesh/catalog"]`; diagnostics includes the full summary.

Compare that summary with the authenticated `tools/list` response and the inputs shown by your MCP application. Refresh the affected connector when its catalog is stale. Keep the existing credential unless it needs rotation for a separate reason, and keep its secret-bearing MCP URL private.

The fingerprint covers public JSON schemas, descriptions, annotations, scopes and action mappings. The Worker performs additional cross-field validation at runtime. Applications that ignore `_meta` can use the tools, but need to compare the displayed schemas directly.

## Upgrade missing capabilities

Install a verified Runner release containing the required feature, reconnect it to a compatible Worker, then repeat diagnostics. Worker deployment, Runner installation and connector refresh are separate steps.

Before forwarding `context.storage` or `context.prune`, the Worker checks that exact method in the current connection's advertisement. Missing support returns `runner_upgrade_required` with `operation_state=not_started`, and the connection remains available for supported operations.

## Diagnostic resource use

Public health reads the catalog without accessing Registry, Runner or D1. Diagnostics uses the existing `env.info` RPC and cached executable probes, with normal authorization traffic. It creates no optional Job/audit history entry or Runner profile change.
