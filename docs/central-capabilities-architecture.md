# Central MCP and Skill architecture

[简体中文](central-capabilities-architecture.zh-CN.md)

Current development behavior: every valid authenticated client in an instance shares the enabled, published MCP tools and active Skills. Administrators connect MCP services and install Skills in the control panel. Clients do not need individual capability assignments. Production activation remains subject to the [rollout gates](central-rollout.md).

## Ownership and dependency direction

One MCP connection exposes native Runner tools, centrally connected remote MCP tools and Skill content. Central operations do not select a Runner, create native Jobs, or install content on execution machines. Native scopes, Runner policy, workspace permissions and the Worker–Runner protocol retain their existing meaning.

| Boundary | Owner | Dependency constraint |
| --- | --- | --- |
| Client identity and native permissions | Registry and existing authentication | Native authentication does not require central storage |
| Shared discovery and invocation | application/capabilities | Narrow identity, profile, catalog and transport ports; no SQL or SDK ownership |
| Publication and version rules | domain/capabilities and contracts | No platform I/O, SDKs or Runner dependency |
| Remote connection protocols and credentials | platform/connectors | No Skill implementation or host execution dependency |
| Skill content and activation | Skill application/domain/platform modules | No automatic execution or permission assignment |
| Public MCP providers | mcp/providers | Adapt contracts; do not import application implementations or stores |
| Composition | capabilities-do.ts and HTTP entry points | Supply feature ports without duplicating admission rules |

Managed OAuth application code owns authorization state, durable claims, refresh ordering and credential leases through SDK-free contracts. Platform adapters own protocol discovery, bounded HTTP and SQLite. Only the composition root wires these implementations together. Connector and Skill internals communicate through ports rather than importing one another.

The architecture gate enforces module ownership, reverse-dependency restrictions, runtime/type cycle checks and SDK-free contracts. Pure central modules cannot perform platform-global I/O or dynamic code evaluation. These are maintenance checks, not an operating-system sandbox.

## Shared admission and publication

Client authentication remains mandatory. Invalid, rotated or revoked credentials cannot discover or invoke central capabilities. Version-2 identities may have empty native scopes and still use the shared library; this does not grant Runner filesystem or execution access. Existing legacy identities keep their native scope behavior.

Catalog readers return the enabled profile’s reviewed, compatible tools. Invocation revalidates client identity, profile state, approved catalog/schema, current upstream schema and credential generation across waits. A previously listed tool is not a reusable authorization ticket. In-flight identity, profile or publication changes withhold results. Deadlines remain bounded; uncertain remote mutations are not replayed automatically.

remote_profiles discovers published service IDs and names from local metadata. remote_tools pages each service’s published catalog and remote_call performs controlled invocation. Small libraries also expose direct tool names. Exceeding the direct directory limits falls back to these discovery tools instead of silently losing access to larger libraries.

Skill listing returns each enabled Skill’s current active digest. Reads require that exact active digest and recheck identity and head revision before returning content. Publishing a new version updates every client; an old cached digest is denied and the client refreshes skill_list. Historical bundles remain stored for administrator review or explicit rollback. Dependency status is advisory and never executes, enables or authorizes a capability.

## Storage and upgrade behavior

CapabilitiesDOv1 remains the central state owner. Registry and Runner tables, identities, credentials and namespaces are not rewritten. The central schema bootstrap preserves archived v1 grant rows, but live listing, invocation and Skill reads never consult them. No default wildcard grant or fallback ACL is created.

The Client access UI, grant RPCs and toolset assignment implementation are retired. Requests below /admin/central/grants and /admin/central/toolsets return HTTP 410 with central_client_access_retired and cannot mutate state. These routes do not resolve the central owner. Existing restrictive or disabled grant records therefore no longer limit valid clients.

Catalog cursors use version 2 and a version-2 MAC namespace. They remain bound to client identity, credential generation, profile/catalog revisions, page size and expiry. Old cursors are rejected; clients must refresh the catalog. No stored client secret needs to be replaced for this change.

To withdraw one client, revoke its credential. To withdraw a capability from all clients, disable the service, publication or Skill. Use separate instances when clients must have separate capability libraries. Upstream OAuth authorization remains distinct from client capability assignment: managed connections retain their service authorization, and existing configured client-bound OAuth accounts retain their own credential boundaries.

Older Worker code can reinstate legacy grant behavior and may reject version-2 identities; rollback is not equivalent to preserving the new shared access model. Review the [administration migration guidance](central-administration.md) before changing deployed versions.

## Bounded operations

| Item | Bound and behavior |
| --- | --- |
| Stored connection profiles | 1,000; discovery scans ordered metadata pages |
| Catalog profiles | 200; only published enabled services are discoverable |
| Direct directory | 8 profiles / 32 tools; overflow uses remote_profiles and remote_tools |
| Catalog | 128 tools per snapshot; client pages up to 20 tools |
| Catalog cursor | 2,048 bytes and 5-minute lifetime; version/revision/identity bound |
| Skills | 1,000 heads; skill_list scans up to 128 heads per page |
| Skill continuation | after / next_after; disabled heads may produce an empty page with a continuation |
| Skill resources/list | Walks bounded pages, rejects duplicate/non-progressing results and never returns a partial success |
| Skill bundle | 32 text files, 64 KiB per file, 256 KiB total, 32 stored versions per Skill |

Limits are explicit safety ceilings, not latency promises. Contracts remain authoritative for byte, count and deadline budgets. Unexpected state fails closed rather than being repaired or cleared automatically.

## Control panel and verification

The normal connection flow asks for a service name, MCP URL and no-authentication or OAuth. Tool publication remains an explicit review step; installing or updating a Skill publishes the current version to the shared library. Admin changes retain same-origin, session and CSRF checks. Stale previews, failed refreshes and revision conflicts cannot silently become successful writes.

Regression coverage includes two independently authenticated clients without grant records, ignored legacy grants, active Skill version changes, more than 128 Skill heads, larger remote directories, credential revocation/rotation, disabled profiles, schema drift, OAuth boundaries, retired routes and unchanged native Runner admission. Browser checks cover the product workflow without screenshots. The full verification plan, architecture gate and exact-commit CI remain release requirements.

See [administration](central-administration.md), [catalog review](central-catalog.md), [remote MCP](central-remote-mcp.md), [Skills](central-skills.md) and [OAuth](central-oauth.md) for feature-specific contracts.
