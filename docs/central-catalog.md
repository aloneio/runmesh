# Central catalog review (development)

For the optional W05 live discovery/call adapter and its explicit limits, see
[Controlled central HTTP MCP](central-remote-mcp.md). This guide covers the
independently usable review/snapshot path.

[简体中文](central-catalog.zh-CN.md)

**Status: enabled shared catalogs in development; production activation remains separate.**
All authenticated instance clients share the enabled published selection. The
control panel connects MCP URLs with no authentication or OAuth, then discovers
and reviews tools. This page describes the underlying snapshot contract.

## Review workflow

Create a connection profile through the W03 administrator API first. Its ID,
Connector ID and endpoint bind the catalog. A catalog can be reviewed while the
connection is disabled; a disabled connection exposes no tools to clients.

Use the administrator session, same-origin request and matching CSRF cookie and
`x-csrf-token` header for POST requests to `/admin/central/catalogs/{profile_id}`.
Never put credentials in tool descriptions or schemas: approved descriptive
content is not encrypted secret storage.

| Operation | Body or query | Effect |
| --- | --- | --- |
| Import a complete capture | `{"action":"stage","expected_revision":0,"tools":[...]}` | Records the latest imported snapshot; does not approve it |
| Inspect | GET with no query | Returns current head, the imported snapshot and a change summary |
| Read a retained snapshot | GET with `?snapshot=<digest>` | Reads that immutable version in the same profile |
| Approve selected tools | `{"action":"approve","expected_revision":1,"digest":"<digest>","tool_names":["search"]}` | Explicitly approves only those tools from the latest capture |
| Disable the catalog | `{"action":"disable","expected_revision":2}` | Removes its approved selection without deleting snapshots |

Every successful mutation advances the head revision. Stale writes return a
conflict instead of overwriting another review. An identical imported snapshot
reuses its body, but still advances the observation revision. No directory read
polls an upstream server or creates a native Job.

The imported capture is administrator-supplied evidence, **not proof of a live
upstream response**. The controlled HTTP discovery/egress adapter uses the same lifecycle. Failure to contact an upstream must never stage an empty
capture. An explicitly imported empty array represents a genuinely empty catalog
and quarantines previously available tools.

## Identity and changes

Stable tool IDs are derived from profile/Connector/endpoint/upstream-name identity
using a full SHA-256 digest. Public names include a bounded readable prefix and
the full digest, remain within 128 allowed ASCII characters, and do not use the
upstream server display name as a unique identifier. A metadata change preserves
the public name but changes the tool content version and snapshot digest.

Titles, descriptions, accepted schemas and annotations are part of that content.
Annotations are untrusted hints, not execution permissions. Field ordering and
upstream list ordering are normalized; array semantics within schemas are not
reordered. Unsupported descriptor fields are rejected, not silently stripped.

The approved selection and latest imported capture are separate. Changed or
removed tools are immediately excluded from the old approved view; unchanged,
previously selected tools can remain visible. New/changed tools require explicit
review before the new content version is published to all authenticated clients. Restoring an old snapshot requires explicitly importing and reviewing it;
this does not assert that the live upstream has rolled back.

The shared selection is per connection profile. Legacy client grants and toolset
assignment are retired; neither participates in live reads or calls.

## Bounded schema contract

The initial metadata subset uses JSON Schema 2020-12 (implicit or explicit).
Inputs must have an object root; outputs may describe other JSON types. Accepted
keywords cover basic types, properties, required fields, enums/constants, numeric
and size bounds, compositions, conditionals, local definitions and acyclic local
references. Literal property names and default/example data are not mistaken for
schema instructions.

Patterns, patternProperties, formats, remote references, recursive references,
dynamic references, IDs/anchors, custom headers and unknown keywords/dialects are
not supported. Tool icons and arbitrary `_meta` are also not yet imported. These
limits intentionally reject some valid broader MCP definitions. Nothing is
silently converted into a weaker schema. Catalog ingestion checks structure and budgets. The remote invocation adapter
validates arguments against the reviewed subset before dispatch.

## Shared directory views

listCatalog authenticates the current client credential generation and returns
the intersection of the approved selection and unchanged observed definitions.
It requires no Runner, native scope or per-client grant.

Queries select one profile and return at most 20 tools after publication
filtering. Version-2 HMAC cursors bind the owner namespace, client/generation,
profile/revision, catalog revision, page limit and five-minute expiry. Old v1
cursors are rejected; clients must refresh. Each page rechecks identity and
publication after asynchronous work. A cursor is not an authorization token.

remote_profiles lists published shared services; remote_tools pages their tools.
Small direct directories also expose reviewed rm_ aliases. Larger libraries use
the bounded discovery surface without requiring manually supplied profile IDs.

## Storage, budgets and recovery

Catalog tables have their own version marker within the optional central owner.
Snapshot bodies are immutable. Insertion and head changes share one transaction;
a failed head update cannot leave a published or orphaned new snapshot. Unknown
or incomplete schema state fails closed without reset. No credentials, full call
arguments, Runner state or external results are copied into these tables.

| Initial ceiling | Limit |
| --- | --- |
| Tools per profile capture | 128 |
| One tool definition | 32 KiB |
| Capture request / stored snapshot | 512 KiB each |
| Canonical JSON depth / nodes | 16 / 8,192 |
| Schema nodes / containment depth | 2,048 / 12 |
| Catalog profiles / snapshots | 200 / 512 |
| Retained versions per profile | 32 |
| Total snapshot body storage | 16 MiB |
| Page tools / cursor size / cursor expiry | 20 / 2 KiB / 5 minutes |

Capacity errors never trigger automatic deletion of reviewed content; existing
catalogs can still be disabled. These are safety ceilings, not measured
production throughput. The 100-profile/2,000-tool test is a synthetic local
inventory test, not 100 real connected MCPs or a production load benchmark.

Production activation remains separate. Runner code, Worker–Runner wire
contracts and native tool definitions are unchanged. The optional feature's absence does not
resolve its storage or credential ports. The old catalog/host mismatch acceptance
items are not closed by local tests.

Protocol references (checked 2026-09-24):
`https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx`
and `https://json-schema.org/understanding-json-schema/structuring`.
