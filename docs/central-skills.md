# Central Skill content (development)

[简体中文](central-skills.zh-CN.md)

W07 adds bounded, reviewed text bundles in the optional Capabilities owner. This
is development code, not a production activation or evidence of real-host
acceptance. No Runner installation, model loop, shell execution or permission
grant occurs when importing or reading content.

## Enable and import

Both the optional CAPABILITIES binding and CENTRAL_SKILLS_ENABLED=1 are required
to expose the Skill HTTP/MCP surfaces. Absent flags leave the ten native tools
and native calls independent of central storage. The shipped production and
development Wrangler environments remain unchanged.

Open /admin/central with the existing administrator session. Skill mutations
require same-origin requests and the current CSRF token. The JSON API is
GET/POST /admin/central/skills/{skill_id}. The ID comes from the path, not the body.

1. Submit action preview with source, license and files (path/text objects).
2. Inspect the returned bundle and digest. Preview writes nothing.
3. Submit the same collection with action stage and expected_revision (0 to create).
4. Read the staged bundle, then submit action activate, digest and expected_revision.
5. Grant a client the exact skill ID and digest, directly or through a reusable
   toolset. Import and activation never grant access by themselves.

Include SKILL.md with a frontmatter name and description. This first importer
supports single-line scalar values (including simple quotes); multiline YAML
scalars, aliases, anchors and general YAML parsing are not supported. The name
uses lowercase letters/digits and internal hyphens, up to 64 UTF-8 bytes.
Frontmatter and bodies remain user-provided content. allowed-tools and capability
declarations do not alter ACLs. Source/license metadata is supplied by the
administrator; a digest verifies consistency, not authorship or trust.

Only text collections are accepted. Archives, links and executable installation
are not implemented. Absolute/traversal paths, empty segments, Windows reserved
names/streams, backslashes and case-folding collisions are rejected. A file
object can contain only path and text. Limits: 32 files, 64 KiB per file, 256 KiB
per canonical bundle, 512 KiB per admin request, 32 versions per Skill, 1,000
Skills and 16 MiB total stored bundles. These are safety ceilings, not capacity
measurements. Reaching retention limits requires an explicit future archival
design; old approved versions are never silently deleted or overwritten.

## Read, update and revoke

skill_list returns only authorized approved metadata, without loading bodies.
The bounded response includes at most the client's 128 grant rules; arbitrary
cursors are rejected rather than accepted without subject binding. skill_read
takes skill_id, digest and path (default SKILL.md). Reuse the same digest for
every attachment in a task.

MCP resources expose the same use cases at
runmesh-skill://bundle/{skill_id}/{digest}/{path}. resources/list advertises
SKILL.md; attachments are read on demand at their exact paths. Both surfaces
revalidate the credential generation and grant before returning content. Unknown
dependencies fail explicitly instead of returning an invented empty directory.

Updates create new immutable bundles. Activation changes the current head and
approves that digest; old approved versions remain readable only with a matching
grant. A rollback explicitly activates a retained digest with the current
revision. Disable blocks all later reads for that Skill while retaining data.
Grant revocation blocks later reads but cannot erase content already delivered
to a client's context. Scripts are always returned as text.

An optional runmesh.json text sidecar declares Runmesh-specific dependencies:
schema_version: 1 and requiredCapabilities: an array of at most eight exact
CapabilityTarget objects (kind, resource_id, version, plus connection_profile_id
for remote_tool). This is a product extension, not standard Skill frontmatter.
The sidecar participates in the immutable digest. Duplicates, extra fields and
unsupported capability kinds are rejected. skill_list exposes only declarations.
skill_read returns dependencies with configured, not_configured, not_authorized,
disabled, incompatible or unavailable states; resources/read returns the same
observations in content _meta under runmesh/dependencies. Unauthorized targets
are not probed. Configuration is checked only against bounded stored metadata;
configured does not prove supplier reachability or OAuth token validity. No
network probe, recursive loading, installation or permission upgrade occurs.
Native prerequisites remain content and are checked at execution; reading never
selects a Runner. Calls always perform their own current admission checks.

## Verification boundary

Domain, SQLite and real local Worker/Registry/MCP entry tests exercise path
rejection, preview without writes, revision conflicts, rollback, old attachments,
revocation during reads, no-body metadata listing, two independent client
credentials, resources/tool parity and feature-off zero central I/O. These are
local fixtures, not two real AI products or public supplier acceptance. See
[the rollout checklist](central-rollout.md) for remaining external gates.
