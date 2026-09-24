# Central catalog review (development)

[简体中文](central-catalog.zh-CN.md)

**Status: W04 directory foundations on dev; central storage remains test-bound.**
This is not an enabled MCP proxy or an upstream connection guide. W04 adds
manual catalog capture, immutable snapshots, reviewed tool selections and a
permission-filtered internal reader. It does not discover or invoke an upstream
server, install a Skill, or change the native MCP tool catalog.

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
upstream response**. W05 must connect the reviewed HTTP discovery/egress adapter
to the same lifecycle. Failure to contact an upstream must never stage an empty
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
review and a grant for their new content version. Approval never writes client
grants. Restoring an old snapshot requires explicitly importing and reviewing it;
this does not assert that the live upstream has rolled back.

The shared selection is currently **per connection profile**. A standalone named
ToolsetProfile spanning several connections is not implemented in this batch.
Keep that later grouping separate from directory integrity and execution policy.

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
silently converted into a weaker schema. W04 checks metadata structure and
budgets; it does **not** implement a runtime argument validator. W05 must supply
and test an evaluator for the declared subset before invocation is enabled.

## Per-client directory views

The internal `listCatalog(principal, query)` reader authenticates the current
credential generation and checks live central grants. It requires no Runner and
does not use coding scopes as central permission. Only the intersection of the
approved selection, unchanged observed tools and exact client grants is visible.

Queries select one profile and return at most 20 tools. Filtering precedes
pagination, so hidden tools and their counts are not disclosed. HMAC cursors bind
the owner namespace, client/generation, profile/revision, grant revision, catalog
revision, page limit and a five-minute expiry. Each page rechecks identity and
state after asynchronous work; a cursor is not an authorization token.

No MCP `tools/list` registration is added here. The later thin remote provider
will consume the same directory reader, not duplicate its policy. Ordinary
Runmesh clients still receive the original native directory.

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

Production/development bindings, Runner code, Worker–Runner wire contracts and
native tool definitions are unchanged. The optional feature's absence does not
resolve its storage or credential ports. The old catalog/host mismatch acceptance
items are not closed by local tests.

Protocol references (checked 2026-09-24):
`https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx`
and `https://json-schema.org/understanding-json-schema/structuring`.
