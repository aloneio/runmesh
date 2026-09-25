# Controlled central HTTP MCP (development)

This page describes the W05 stateless baseline. The optional W06 OAuth and
ephemeral-session extensions and their narrower support limits are documented in
[Central OAuth](central-oauth.md). All deployment activation remains explicit.

[简体中文](central-remote-mcp.zh-CN.md)

**W05 implementation on dev; no production activation.** Central HTTP discovery
and invocation now connect the W03 credential profiles and W04 reviewed catalog.
The shipped deployment configuration still has no central binding or outbound
policy in production/development. Do not interpret this document as an enabled
service, a published release, or a successful public-network acceptance test.

## What is implemented

The Worker is the unified entry point. A client does not install upstream MCPs on
each Runner. Central operations can run without any Runner registration, selection
or machine permission. The client continues to reason and may separately invoke
the existing Runner tools; Runmesh does not execute upstream text as shell code.

The optional `remote_tools` tool reads reviewed definitions for one profile;
`remote_call` accepts that profile, exact tool ID, approved version and arguments.
The native ten-tool factory and its reviewed contracts remain unchanged. The two
central tools are registered only when CAPABILITIES and a valid outbound policy
exist. Construction and native-only calls do not resolve central storage, read
vault keys or create an upstream connection. A central error therefore does not
remove the native tools. This is a discovery/call interface, not dynamic injection
of thousands of tools into every host's catalog.

## Supported protocol subset

Use an explicitly configured protocol per exact endpoint: `2026-07-28`, or the
stateless Streamable HTTP compatibility lane `2025-11-25`. The official MCP client
SDK is pinned to 2.0.0 and isolated in a platform adapter. Its Cloudflare JSON
Schema interpreter validates the already restricted catalog schema dialect
without dynamic code generation. Arguments are not coerced and defaults are not
silently inserted. A conservative expanded-schema/data work ceiling rejects
expensive inputs rather than accepting an unbounded synchronous computation.

Both JSON and request-scoped SSE responses are supported. Text, image, audio,
embedded resources, resource links, structured results and tool-level `isError`
are retained. Links are data and are never fetched by the relay. Progress/log
notifications are bounded and discarded; root transport metadata is not forwarded
into a client's authentication UI. There is no continuous progress relay.

OAuth refresh/step-up, arbitrary headers, query-string credentials, stdio hosting,
long-lived sessions, standalone GET SSE, resumption, tasks, sampling, elicitation,
and multi-round input are not implemented. Session-bearing responses and unsupported
interactive results fail explicitly. There is no protocol fallback after a failed
call. W06 and later work must add these capabilities as independently tested
adapters rather than weaken this subset's assumptions.

## Configuration and review flow

For a separately reviewed test deployment, use an independent vault keyring and
the exact, canonical, credential-free HTTPS policy below. This example contains
no usable credentials and is not installed by this change:

```json
{
  "schema_version": 1,
  "endpoints": [
    { "endpoint": "https://api.example.com/mcp", "protocol": "2026-07-28" }
  ]
}
```

The variable is `CENTRAL_MCP_EGRESS`. Absent or malformed configuration disables
the remote entry points. Ports other than canonical HTTPS 443, IP literals,
private/ambiguous host forms, wildcards, user information, query strings and
fragments are rejected. A profile must be enabled and match a policy entry.

Create and enable a profile using the existing protected administration API.
POST `/admin/central/discovery/{profile_id}` with `{"expected_revision":0}` and
the administrator's existing session, same origin and matching CSRF token. The
complete bounded tools/list result is staged into the W04 catalog, never approved.
Then inspect and approve selected tools through the catalog review API. Finally
grant each client the exact tool IDs, versions and connection profile through the
[W08 administration console](central-administration.md). Identity creation,
profile enablement and catalog approval alone are not a client grant.

The discovery endpoint permits no caller URL, token, HTTP headers or command.
Partial pages, duplicate tools, unsupported schemas, timeouts and failed upstream
observations leave the previously reviewed catalog intact. An actual change in
the selected tool's description/schema/annotations blocks invocation until the
catalog is discovered and approved again. The call does not auto-approve changes
or create a new catalog revision for every request.

## Trust and execution boundaries

Outbound requests use a newly constructed header set and only that profile's
decrypted bearer. Client URL secrets, inbound Authorization, browser cookies,
Runner tokens and control-plane secrets are not forwarded. Headers needed by the
pinned protocol are set by the adapter. Redirects and authentication discovery
are not followed. No automatic auth provider, reconnect or replay is configured.
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
against its approved definition. Grant, catalog, profile and identity revisions
are rechecked after awaited work. There is no cache that turns old tool visibility
into current execution permission.

After dispatch, failures can mean the action executed but its response was lost.
The response reports `operation_state: unknown`; neither read-only hints nor
idempotency annotations trigger an automatic retry. When a valid result arrives
after the client's access was revoked, output is withheld while the action is
reported completed. Local cancellation or deadline expiry cannot roll back an
upstream effect. No exactly-once or cross-owner atomic transaction is promised.
An outer MCP disconnect cannot prove that the owner RPC was canceled.

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
oversize/invalid responses and post-dispatch failures. They do not connect to
private accounts or claim live public-provider interoperability.

Primary implementation references:
- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Cloudflare public fetch compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)
- [workerd public-only network and DNS filtering](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)
- [Cloudflare-compatible JSON Schema interpreter](https://github.com/cfworker/cfworker/tree/main/packages/json-schema)
