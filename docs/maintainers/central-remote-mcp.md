# Controlled central HTTP MCP

> Maintainer reference: interfaces, protocol and verification boundaries. For everyday use, see the [user guide](../central-remote-mcp.md).

This page describes the current controlled remote transport. Managed OAuth and
operation-local sessions are documented in [Central OAuth](central-oauth.md).
All deployment activation remains explicit.

[简体中文](central-remote-mcp.zh-CN.md)

Central HTTP discovery and invocation connect
control-panel profiles to the reviewed catalog. Development and production source
configurations include the independent central binding and enable Skills,
direct-directory and governance. Managed connections store their endpoint policy
through the control panel. OAuth encryption derives its key from the existing
deployment secret. See [release status](../release-readiness.md) for deployment
and upgrade steps, and the [rollout ledger](../central-rollout.md) for acceptance evidence.

## What is implemented

The Worker is the unified entry point. A client does not install upstream MCPs on
each Runner. Central operations can run without any Runner registration, selection
or machine permission. The client continues to reason and may separately invoke
the existing Runner tools; Runmesh does not execute upstream text as shell code.

remote_profiles lists services with published tools. remote_search searches their
current published definitions by keyword. remote_tools reads the
reviewed definitions for one profile; remote_call accepts the profile, exact
tool ID/version and arguments. Every valid authenticated client shares these
publications; no grant rows are needed. Client credentials, disabled services,
upstream OAuth and exact live schemas are still checked. Native-only calls do
not resolve central storage, credentials or upstream connections. Discovery failures
preserve native tools. Large libraries use bounded service/tool discovery.

`parseCatalogTool()` in `apps/worker/src/contracts/catalog-values.ts` shares
published-entry validation across stored snapshots and MCP providers. Snapshot
validation retains strict entry fields, name ordering and unique tool IDs.
Paged and direct providers project the public fields from RPC data; each
container retains its own size and count budgets. An invalid optional direct
directory makes `remote_status` report `unavailable`, while native tools remain
available.

Catalog history retains up to 32 snapshots per connection, within the global
512-snapshot and 16 MiB budgets. When saving a new snapshot needs space, the
store reclaims the oldest unreferenced history in the same transaction. Current
observed and approved snapshots remain available; retained digests can still be
viewed and staged again. If those references leave insufficient space, the
capacity result preserves the existing history and publication.

## Published-tool search

`remote_search` accepts `query`, optional `profile_id`, and optional `limit`.
The query is bounded to 256 UTF-8 bytes; results default to 10, with a maximum
of 20. Keywords match tool names, titles, descriptions and connection names.
Exact names rank first, with deterministic profile/tool ordering for ties.

Each result includes `profile_id`, `profile_name`, `profile_revision`,
`catalog_revision`, `tool_id`, `version`, `name` and a description of at most
512 characters. Use the profile ID with `remote_tools` for the full input schema,
then call `remote_call` with the selected tool ID, version and arguments.

The application searches verified published snapshots through read ports. It
retains only the requested top results in memory, with scan budgets of 16 MiB
and 25,600 tools. Identity and the publication set are checked again before
return. A capacity result asks the client to narrow the query with `profile_id`;
a changed publication returns `stale_catalog`. Search uses request-local state
and makes no upstream calls or persistent index writes.

## Protocol support

Control-panel connections negotiate a supported MCP version with the saved endpoint;
users do not configure protocol versions. The official MCP client SDK is pinned
to 2.2.0 and isolated in a platform adapter. Its Cloudflare JSON
Schema interpreter validates the already restricted catalog schema dialect
without dynamic code generation. Arguments retain their supplied types and
values, including omitted fields. Validation rejects inputs whose estimated
expanded-schema/data work exceeds the configured ceiling.

Both JSON and request-scoped SSE responses are supported. Text, image, audio,
embedded resources, resource links, structured results and tool-level `isError`
are retained. Links are data and are never fetched by the relay. Progress/log
notifications are bounded and discarded; root transport metadata is not forwarded
into a client's authentication UI. There is no continuous progress relay.

Managed OAuth and operation-local sessions are supported; see [OAuth](central-oauth.md).
Arbitrary headers, query credentials, stdio hosting, persistent sessions, GET subscriptions,
resumption, tasks, sampling, elicitation and multi-round interactions are unsupported.
Failed calls are not replayed.

## Connection and publication flow

POST `/admin/central/connection-check` accepts either `{endpoint}` for a new
public MCP URL or `{profile_id}` for an enabled saved connection. It uses the
existing administrator session and same-origin CSRF checks. Saved connections
use their current managed credentials. The operation performs the handshake
and reads `tools/list` when the service advertises tools, then closes the session
and rechecks authorization and credential validity.

The response projects the endpoint, negotiated protocol, capability booleans,
tool count and observation time. The UI distinguishes a checked tool count from
other service declarations. A sign-in requirement returns
`{state:"authorization_required"}`. Checking leaves profiles and published
catalogs unchanged; connection and tool refresh remain separate actions.

POST `/admin/central/registry-preview` accepts `{entry}` containing one
`server.json` object or a Registry wrapper with a `server` field. The same
administrator/CSRF boundary applies. The request is bounded to 256 KiB, with
at most 16 remotes, 16 packages and 32 header names per remote. The transient
response includes name, version, description, schema URL, digest and observation
time, plus projected remote and package entries.

Public Streamable HTTP URLs with complete paths and no header or variable
configuration become connection-form candidates. URL placeholders, including
encoded braces, and configured headers or variables mark an entry for provider
setup. Preview exposes header names and package identifiers while discarding
header values, variable values and launch arguments. **Use this connection**
fills the ordinary form; the administrator chooses authentication and selects
**Connect**. Import processes the selected file once and stores no directory
snapshot or connection changes.

Enter a public HTTPS MCP URL and select No authentication or OAuth in the control panel.
The saved enabled connection is exact outbound admission; no environment allowlist or
manual bearer configuration is supported. OAuth uses the existing deployment secret. Nonstandard
HTTPS ports, IP literals, private hosts, wildcards, URL credentials, queries and fragments are rejected.

Create and enable a profile using the existing protected administration API.
POST `/admin/central/discovery/{profile_id}` with `{"expected_revision":0}` and
the administrator's existing session, same origin and matching CSRF token. The
complete bounded tools/list result is stored and published atomically in one
catalog revision. Every discovered tool is immediately available to authenticated
clients; the connection requires no additional review or approval in the
[control panel](central-administration.md). Client credentials remain required;
publication grants no Runner permissions.

The discovery endpoint permits no caller URL, token, HTTP headers or command.
Partial pages, duplicate tools, unsupported schemas, timeouts and failed upstream
observations leave the previously reviewed catalog intact. An actual change in
the selected tool's description/schema/annotations blocks invocation until the
catalog is refreshed, which publishes all current tools. The call does not publish changes
or create a new catalog revision for every request.

## Trust and execution boundaries

Outbound requests use a newly constructed header set and the service access token only for OAuth connections. Client URL secrets, inbound Authorization, browser cookies,
Runner tokens and control-plane secrets are not forwarded. Headers needed by the
pinned protocol are set by the adapter. Redirects are not followed. Authentication belongs to the managed OAuth adapter;
no automatic reconnect or tool replay is configured.
`x-runmesh-mcp-hop` rejects relay recursion on incoming Runmesh MCP endpoints.

Preserve `global_fetch_strictly_public`, already enabled in the repository's
Wrangler configuration. It routes same-zone requests through the public front
door instead of bypassing zone security. Standalone workerd deployments must
retain the default public-only global outbound network and DNS address filtering;
do not wire this adapter to a private network, VPC binding, origin binding or a
fetch implementation with broader access. Exact allowlisting is a separate
application control, not a claim that a DNS preflight pins a later connection.
Deployment/network acceptance still needs independent verification.

Every operation uses a fresh SDK client and credential context. Permission and
profile generation checks occur before decryption, before network rounds, and
again immediately before tools/call. A fresh tools/list checks the selected tool
against its approved definition. Catalog, profile and identity revisions
are rechecked after awaited work. There is no cache that turns old tool visibility
into current execution permission.

After dispatch, failures can mean the action executed but its response was lost.
The response reports `operation_state: unknown`; neither read-only hints nor
idempotency annotations trigger an automatic retry. When a valid result arrives
after the client's access was revoked, output is withheld while the action is
reported completed. Local cancellation or deadline expiry cannot roll back an
upstream effect. No exactly-once or cross-owner atomic transaction is promised.
An outer MCP disconnect cannot prove that the owner RPC was canceled.

Completed calls close their operation-local session before the final client and
publication checks. Credential leases and outbound policy are checked again after
that asynchronous cleanup; a changed authority withholds the result without
replaying the completed action. Failed cleanup alone does not discard a valid
result. Discovery retains the same credential/policy fence through catalog
hashing and the final publication transaction.

## Bounded operation and persistence

| Budget | Initial ceiling |
| --- | --- |
| One owner operation | 20 seconds |
| Active operations per owner / per client | 2 / 1; no waiting queue |
| Outbound request / response | 64 KiB / 1 MiB |
| Aggregate response bytes | 2 MiB |
| HTTP requests / tools/list pages | 12 / 8 |
| Tools in a complete catalog | 128, within existing W04 byte/node bounds |
| Body fragments / SSE events | 4,096 / 256 |
| Returned content items | 32 |
| Outbound endpoint policy | 64 entries / 16 KiB |

These are admission ceilings, not throughput or cost guarantees. They include
connect, list, validation and execution work. Transient concurrency state is not
a distributed rate limiter. Restart does not replay work. Calls do not create
Runner Jobs, write argument/result payloads to audit tables or install timers
outside their request lifetime. W09 adds optional metadata-only durable call
receipts, owner-local rate limits and cooldown via CENTRAL_GOVERNANCE_ENABLED=1;
see [administration and governance](central-administration.md). Broader cost
measurements and live acceptance remain external gates.

## Verification scope and references

Tests cover the official client/server SDKs across real Fetch Request/Response
objects, an actual local DO/SQLite and Registry authorization chain, and synthetic
upstream handlers. They include both protocol lanes, fragmented UTF-8 SSE,
credential isolation, changed schemas, revoked access, concurrent admission,
oversize/invalid responses and post-dispatch failures. Additional regressions
cover inspection without business calls or publication, projected HTTP results,
Registry secret filtering and placeholders, deterministic search, bounded result
counts and authorization/publication changes. Live public-provider acceptance is
recorded in the rollout ledger.

Primary implementation references:
- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Cloudflare public fetch compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)
- [workerd public-only network and DNS filtering](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)
- [Cloudflare-compatible JSON Schema interpreter](https://github.com/cfworker/cfworker/tree/main/packages/json-schema)
