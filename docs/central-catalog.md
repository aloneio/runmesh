# MCP catalog implementation

[简体中文](central-catalog.zh-CN.md) · [Maintainer documentation](maintainers/README.md)

This reference describes catalog APIs, snapshot storage and schema validation.
To connect an MCP and refresh its tools from the control panel, follow the
[MCP and Skill guide](central-administration.md). The
[HTTP MCP implementation](maintainers/central-remote-mcp.md) covers live discovery
and invocation.

All authenticated instance clients share the enabled published selection. The
control panel connects MCP URLs with no authentication or OAuth, then discovers
and automatically publishes every discovered tool in one revision. This page
describes the underlying snapshot contract.

## Snapshot administration

Create a connection profile through the [administrator API](maintainers/central-administration.md) first. Its ID,
Connector ID and endpoint bind the catalog. A catalog can be reviewed while the
connection is disabled; a disabled connection exposes no tools to clients.

Use the administrator session, same-origin request and matching CSRF cookie and
`x-csrf-token` header for POST requests to `/admin/central/catalogs/{profile_id}`.
Tool descriptions and schemas are shared with authorized readers. Store account
credentials through the connection's authentication settings.

| Operation | Body or query | Effect |
| --- | --- | --- |
| Publish a complete capture | `{"action":"publish","expected_revision":0,"tools":[...]}` | Stores and publishes every tool atomically; used by live discovery |
| Import a complete capture | `{"action":"stage","expected_revision":0,"tools":[...]}` | Records the latest imported snapshot; does not approve it |
| Inspect | GET with no query | Returns current head, the imported snapshot and a change summary |
| Read a retained snapshot | GET with `?snapshot=<digest>` | Reads that immutable version in the same profile |
| Approve selected tools | `{"action":"approve","expected_revision":1,"digest":"<digest>","tool_names":["search"]}` | Explicitly approves only those tools from the latest capture |
| Disable the catalog | `{"action":"disable","expected_revision":2}` | Removes its approved selection without deleting snapshots |

Every successful mutation advances the head revision. Stale writes return a
conflict instead of overwriting another review. An identical imported snapshot
reuses its body, but still advances the observation revision. No directory read
polls an upstream server or creates a native Job.

Manual imports record administrator-supplied definitions. Live discovery records
the upstream response and publishes it atomically; a connection failure preserves
the existing catalog. An explicitly imported empty array represents an empty
catalog and quarantines previously available tools.

## Identity and changes

Stable tool IDs are derived from profile/Connector/endpoint/upstream-name identity
using a full SHA-256 digest. Public names include a bounded readable prefix and
the full digest, remain within 128 allowed ASCII characters, and do not use the
upstream server display name as a unique identifier. A metadata change preserves
the public name but changes the tool content version and snapshot digest.

Titles, descriptions, accepted schemas and annotations are part of that content.
Annotations provide hints; execution permissions are checked separately. Field
ordering and upstream list ordering are normalized, while arrays within schemas
retain their order. Tool definitions accept `name`, `title`, `description`,
`inputSchema`, `outputSchema` and `annotations`. An additional descriptor field
causes the complete capture to fail validation.

Live discovery publishes the complete observed snapshot and all tool names in a
single transaction, including an empty catalog. The lower-level staged-import
API can keep the approved selection and latest imported capture separate. Changed or
removed tools are immediately excluded from the old approved view; unchanged,
previously selected tools can remain visible. A live discovery refresh publishes
new or changed definitions automatically; manual snapshot imports can instead
use stage/approve for separate capture and publication. Restoring an old snapshot requires explicitly importing and reviewing it;
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

Definitions containing `pattern`, `patternProperties`, `format`, remote,
recursive or dynamic references, IDs/anchors, custom headers, or keywords and
dialects outside this subset fail validation. The same applies to tool icons and
arbitrary `_meta`. Prepare definitions using the accepted fields and schema subset
above; validation applies to the complete capture. Catalog ingestion checks
structure and budgets. The remote invocation adapter validates arguments against
the accepted schema before dispatch.

## Shared directory views

listCatalog authenticates the current client credential generation and returns
the intersection of the approved selection and unchanged observed definitions.
It requires no Runner, native scope or per-client grant.

Queries select one profile and return at most 20 tools after publication
filtering. Version-2 HMAC cursors bind the owner namespace, client/generation,
profile/revision, catalog revision, page limit and five-minute expiry. Old v1
cursors are rejected; clients must refresh. Each page rechecks identity and
publication after asynchronous work. A cursor is not an authorization token.

`remote_profiles` lists published shared services; `remote_search` searches their
published names, titles, descriptions and connection names; `remote_tools` pages
complete tool definitions. Search accepts `query`, optional `profile_id` and
optional `limit` (default 10, maximum 20). Its query is limited to 256 UTF-8 bytes.
It reads saved snapshots and rechecks identity and publication before returning;
it does not query upstream services. Results include the exact `tool_id` and
`version` for `remote_call`; use `remote_tools` to read the input schema first.
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

When an incoming snapshot needs capacity, storage reclaims the oldest snapshots
that are no longer the current observed or approved version. It first meets the
profile's version limit, then the shared count and byte limits. Reclamation and
publication share the transaction; if sufficient space cannot be reserved, the
write fails without deleting retained snapshots. Current observed and approved
versions remain protected, and existing catalogs can still be disabled. Retained
history is therefore bounded rather than a permanent archive.

The table defines admission and storage limits. The local inventory
test uses 100 synthetic profiles and 2,000 tools; measure throughput and connected
MCP capacity in the target environment.

Catalog storage and credential ports are resolved when the central feature is
enabled. For release acceptance, verify catalog refresh and invocation with a
real MCP client using the [central rollout checklist](central-rollout.md).

Protocol references (checked 2026-09-24):
`https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx`
and `https://json-schema.org/understanding-json-schema/structuring`.
