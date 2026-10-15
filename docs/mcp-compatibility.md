# MCP compatibility matrix

[简体中文](mcp-compatibility.zh-CN.md)

Runmesh relays bounded remote tool discovery and calls, not arbitrary server code or every optional MCP feature.

| Surface | Support and boundary |
| --- | --- |
| Streamable HTTP | JSON and request-scoped SSE, stateful and stateless servers |
| Negotiation | 2026-07-28 discovery plus supported 2025/2024 initialization revisions |
| Session IDs | Visible ASCII, at most 4 KiB, isolated to one operation |
| Response framing | UTF-8 fragments, CRLF/LF, comments/empty heartbeats, complete final SSE frame at EOF |
| MIME variants | JSON and application/*+json; absent/text JSON only with strict JSON-RPC validation |
| Tool descriptors | Known executable fields validated; bounded icons, versions and annotation extensions safely projected |
| JSON Schema | 2020-12, 2019-09, draft-07/06; conservative draft-04/OpenAPI normalization; composition, dependencies, tuples and local acyclic refs/anchors |
| Regex constraints | Structural/input-work budgets; unsafe constraints quarantine tools, never silently relax validation |
| Parameter headers | SDK-derived Mcp-Param-* from string/integer/boolean input bindings |
| Results | Text, image, audio, embedded resources, links, structured JSON and tool errors; non-object structured outputs require the modern wire version |
| Authentication | Existing managed OAuth: CIMD, DCR, pre-registered clients; encrypted credentials and issuer/PKCE/state binding |
| Tool isolation | Supported siblings publish with exclusions; all-unsupported nonempty catalogs preserve the old publication |
| Large libraries | 512 tools per catalog; remote_search/remote_tools/remote_call avoid direct-menu overload |

## Explicit boundaries

No central stdio hosting, automatic deprecated double-endpoint HTTP+SSE fallback,
arbitrary redirects, external schema fetching, execution resumption, or automatic
sampling/elicitation/roots/tasks/multi-round fulfillment is provided. A `/sse` URL
may work if the provider actually serves Streamable HTTP there; suffixes do not
identify transport. Unknown required vocabularies, recursive/dynamic refs and
unsafe regexes are not treated as validation success. Inputs are not coerced,
defaulted or stripped. Hints grant no permissions; IDs are not coerced; uncertain
writes are never automatically retried.

Each operation is limited to 20 seconds, 40 requests and 32 catalog pages.
Response/aggregate limits are 2/8 MiB, tool/catalog limits 64 KiB/2 MiB and content
is limited to 128 blocks. Global storage, graph and evaluation budgets also apply.
These are ceilings, not throughput promises.

Discovery returns bounded `excluded_tools` names and fixed reasons. The UI shows
count and sample names for that refresh. Duplicate names, incomplete pages,
malformed envelopes and global limits retain the prior catalog; a genuine empty
catalog can be published. Inspection counts wire descriptors without executing
business calls and is not a guarantee every schema can execute.

## Verification

Tests include a source-derived synthetic GitLab fixture pinned to
`135fb0218a7aa9cc54a5c2b4033d2f0e7d9b4e0b`, GitHub parameter headers,
legacy/modern SDKs, version downgrade headers, hostile schemas and publication
isolation. The GitLab fixture is not an authenticated user-session capture.

On 2026-10-15 the patched adapter on oci0 completed handshake, tools/list and one
read-only call each against public Microsoft Learn, DeepWiki and Cloudflare
Documentation MCP. All returned `isError: false`; none were installed or published.
This does not validate private GitLab OAuth credentials or future provider versions.
Production GitLab acceptance requires refreshing the existing authorized connection.

References: [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[GitLab MCP](https://docs.gitlab.com/user/model_context_protocol/mcp_server/),
[Microsoft Learn](https://learn.microsoft.com/en-us/training/support/mcp),
[DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki-mcp),
[Cloudflare](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/).
