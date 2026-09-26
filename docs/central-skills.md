# Shared Skill content (development)

[简体中文](central-skills.zh-CN.md)

## Installation and publication

The control panel accepts SKILL.md and supporting text files or a Skill folder.
POST /admin/central/skill-installations derives the ID/name/description from
validated frontmatter, then atomically stores, approves and activates the bundle.
An existing name requires explicit update confirmation with the current revision.
Every valid authenticated client shares the active version immediately; no
per-client grant or template assignment is required. No scripts execute.

The lower-level GET/POST /admin/central/skills/{skill_id} remains available for
preview, stage, activate, disable and inspecting retained bundles. All mutations
require an administrator session, same-origin CSRF checks and an exact revision.
Preview does not write. Stage does not publish; activate publishes the selected
digest. Source/license are optional metadata in the normal install flow.

CAPABILITIES and CENTRAL_SKILLS_ENABLED=1 enable these optional surfaces.
Development enables them; production promotion remains separate. Central
discovery revalidates the client credential; a failed lookup preserves native
tools. Native-only calls do not resolve central storage. Native Runner access is
independent and is never granted by Skill content, allowed-tools or annotations.

## Content and storage bounds

SKILL.md requires name and description frontmatter. The supported subset uses
single-line scalars (including simple quotes), not general multiline YAML,
anchors or aliases. Names use lowercase letters, digits and internal hyphens,
up to 64 UTF-8 bytes. Content is user-supplied; a digest proves consistency, not
authorship or trust. Source/license metadata is not independently verified.

Only text collections are accepted. Archives, remote links and executable
installation are unsupported. Absolute/traversal paths, empty segments, Windows
reserved names/streams, backslashes and case-folding collisions are rejected.
A file object contains only path and text. Limits are 32 files, 64 KiB per file,
256 KiB per canonical bundle, 512 KiB per admin request, 32 versions per Skill,
1,000 Skills and 16 MiB of stored bundles. These are safety bounds, not measured
capacity promises. Old content is never silently deleted to make room.

## List, read, update and disable

skill_list returns active approved metadata without loading file bodies. It
scans up to 128 stored heads per page and returns next_after. Pass that value as
after to continue until null, including after an empty page of disabled items.
Alternatively, select one skill_id; skill_id and after cannot be combined.
An after key is a position, not an access token or snapshot guarantee: each page
revalidates the credential and publication revisions. Concurrent changes may
require restarting discovery.

skill_read accepts skill_id, digest and path (default SKILL.md). Only the current
enabled approved digest is readable. Updating a Skill changes the version for
all clients; cached old digests are denied. Refresh skill_list and use the same
new digest for the body and attachments. Old bundles remain stored for an
administrator to inspect or explicitly reactivate with the current revision.
Disable blocks reads without deleting data. Credential revocation blocks that
client, but cannot erase content already delivered to its context.

MCP resources use the same live checks at
runmesh-skill://bundle/{skill_id}/{digest}/{path}. resources/list walks all bounded
pages and advertises SKILL.md; it rejects failed or looping pagination rather
than returning partial success. Attachments are read on demand. Identity and
publication changes during a read withhold the content. Scripts remain text.

## Dependency metadata

An optional runmesh.json text sidecar contains schema_version: 1 and
requiredCapabilities, at most eight exact CapabilityTarget objects (kind,
resource_id, version, and connection_profile_id for remote_tool). This is a
Runmesh extension, not standard Skill frontmatter. It participates in the digest;
duplicates, extra fields and unsupported kinds are rejected.

skill_list exposes declarations; skill_read reports configured, not_configured,
disabled, incompatible or unavailable using shared publication metadata.
An active Skill dependency must match its exact declared digest. These advisory
checks do not establish upstream reachability or OAuth validity, install or
enable dependencies, execute tools, recursively load content or add permissions.
Actual calls independently perform their current admission checks.

## Verification boundary

Local domain, SQLite, Worker/Registry/MCP and browser tests cover publication,
revision conflicts, old digest rejection, two clients without grants, no grant storage, credential revocation, >128 heads, empty pages, resources
parity, path rejection, no-body listing and unchanged native scope boundaries.
These fixtures do not replace [real-host rollout evidence](central-rollout.md).
