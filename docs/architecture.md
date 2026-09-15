# Architecture of the current checkout

This describes checked-out source, not whichever version is installed on a Runner or deployed to Cloudflare. Generated [current facts](current-facts.md) and [schema-checked examples](tool-examples.md) are checked by `check:docs`. Execution and rollout follow [verification layers](verification.md). Historical ADRs are not instructions to reset a healthy deployment.

## Deployment and authority boundaries

The public MCP/browser entrypoint is the Worker. The local Runner connects outbound over WSS and owns processes, files, Git, full logs and Context records. No inbound Runner HTTP/SSH gateway, model API, cross-Runner fanout or implicit failover is introduced.

RegistryDOv2 owns core identities, permissions, enrollment and policy authority in one SQLite-backed DO. RunnerDOv2 owns live authenticated transport and session/policy fences. Production's independent HISTORY_DB D1 binding serves optional metadata-only audit and packed Job snapshots. Its failure must not become credential loss or fallback history writes into core authority. Current authorization must still succeed before protected work is dispatched.

Each MCP client has an independently revocable secret URL and sticky Runner selection. Switching a non-null selection needs confirmation; an unavailable selected Runner is not silently replaced. Shared authorized workspace Jobs are not private chat sessions. Capabilities and catalog fingerprints describe implementation, not a permission grant or proof of the host client's cached catalog.

## Internal ownership

| Area | Modules | Boundary |
| --- | --- | --- |
| HTTP composition | `apps/worker/src/index.ts` | Routing, response/session protection and retained orchestration |
| Presentation | Extracted `apps/worker/src/admin/` renderers | View data and rendering, no automatic Jobs/log polling |
| MCP | `apps/worker/src/mcp/` | Catalog, handler binding, output validation, bounded projection, reauthorization |
| Foundations | `public-origin.ts`, `platform/env.ts`, `contracts/` | Origin rules, platform types, narrow application contracts |
| Registry domains | `registry/auth.ts`, `policy.ts`, `lifecycle.ts`, `history.ts` | Business groups, narrow ports, original synchronous storage owner |
| Registry facade | `registry.ts` | Compatibility API, schema startup, HTTP/HMAC, maintenance, external history orchestration |
| Runner composition | `apps/runner/src/runtime.ts` | Current policy and service assembly |
| Job adapters | `apps/runner/src/jobs/` | File, process, log and recovery boundaries; JobManager retains lifecycle coordination |
| Context adapters | `apps/runner/src/context/` | Storage/recovery and pure retention planning; executor revalidates paths and authorization |
| Shared protocol | `packages/protocol/src/` | Wire contracts, permissions, operation requirements, pagination and failure metadata |

These are incremental boundaries, not a claim of independent tables or elimination of every large module. Cross-table transactions deliberately stay within one Registry. Domain, foundation and application dependencies are checked in both CI systems; type-inclusive cycles are reported separately from forbidden runtime cycles.

## Authorization, transactions and failures

Tool visibility never replaces authorization. Reauthorization distinguishes unavailable dependencies, actual denial and malformed evidence. RunnerDO keeps its final local policy fence immediately before socket dispatch: no new asynchronous boundary or cached grant may bypass it. Queued Jobs need current authorization before starting.

Registry SQL and transaction callbacks remain synchronous. Registration and initial policy creation share rollback behavior. A storage abstraction must not turn these into remote calls or Promise repositories. Optional audit failure remains separate from execution outcome.

Local Jobs survive MCP response closure and ordinary transport disconnection. Recovery cannot invent exit codes or promise exactly-once process creation. Unknown results require observation rather than blind resubmission; cancellation/stdin are not automatically replayed. Context retention uses explicit preview and current-plan verification, not hidden deletion triggered by a read.

## Resources, installation and compatibility

Ordinary production requires INTERNAL_CONTROL_SECRET and RUNNER_TOKEN_PEPPER as independent stable secrets. ADMIN_TOKEN is optional for the advanced API. Public origin is validated from the routed HTTPS request, with an explicit proxy override when needed. Hosted installation retains the reviewed release record, fixed artifact URLs and signature checks. See [runtime configuration](runtime-config.md) and [portable installation](portable-runner-installation.md).

Normal updates preserve Worker names, v2 namespaces, D1 bindings, credentials and registered services. Unknown incompatible schemas remain an error, not permission to reset a database or widen authorization. Only explicitly supported state changes are allowed; no general import or automatic downgrade guarantee exists. Legacy pre-v2 migration is separate from ordinary upgrades.

The default service identity is dedicated_user; privileged_host needs explicit choice. New MCP clients default to coding:read. First administrator setup needs no additional bootstrap token and retains CSRF, same-origin and atomic first-success-wins checks; complete initialization before exposing an uninitialized instance. Host shell commands have the operating-system account's privileges. Workspace policy is not a sandbox for hostile code.

Full command/output and Context bodies stay on the Runner. Cloud history is bounded metadata; no-record preferences do not remove authorization. Jobs/logs load explicitly. Local snapshots, cursors and cleanup have their own byte/count/time budgets. Local tests cannot prove account-wide Cloudflare cost or deployed hibernation behavior.

## Evidence and remaining work

Pure rules, adapter/schema contracts, Runner integration, local Cloudflare integration, source transport and installed-package transport are distinct layers. Native runs, signed-release verification and production/account observations are separate evidence. Generated facts mark unobserved runtime checks as not_run instead of copying old success forward.

Compatibility facades and broad lifecycle coordinators remain. Extraction does not establish complete correctness or remove all legacy private-state fault injection. Build provenance, host catalog refresh and account acceptance need independent verified delivery. Do not infer them from a product version, this document, or a green unit-test command.
