# Shared Skill content

> Maintainer reference: interfaces, protocol and verification boundaries. For everyday use, see the [user guide](../central-skills.md).

[简体中文](central-skills.zh-CN.md)

## Module ownership

Paths below are relative to `apps/worker/src/`.

| Module | Responsibility |
| --- | --- |
| `contracts/skill-lifecycle-values.ts`, `contracts/skill-lifecycle-receipts.ts` | Validate lifecycle wire values and project bounded success receipts. |
| `application/skills/admin.ts` | Coordinate administrator installation, staging, publication and library inspection through the admin-session authority. |
| `application/skills/reader.ts` | List and read published content through a read-only repository port, revalidate client identity and publication, and derive file manifests. |
| `application/skills/lifecycle.ts`, `domain/skills/lifecycle.ts` | The application coordinates authorized maintenance; the domain owns cleanup eligibility and bounded version comparison. |
| `platform/skills/store.ts`, `platform/skills/lifecycle-store.ts` | Own content, head and maintenance storage, including synchronous publication and cleanup transactions. |
| `platform/skills/capacity.ts` | Read shared metadata totals for installation admission, version history and cleanup results. |
| `http/central-skill-lifecycle.ts`, `capabilities-do.ts` | HTTP owns session/CSRF admission and response status; the Durable Object assembles authorities, repositories and use cases. |

## Installation and publication

The control panel accepts SKILL.md and supporting text files, a Skill folder,
or a public GitHub folder at an exact commit.
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

GET /admin/central/skills lists metadata for `active_digest ?? staged_digest`,
including while paused. The head keeps the selected version and latest upload
separate. GET /admin/central/skills/{skill_id} defaults to the latest upload;
pass `?digest=` to inspect the selected or another retained version. The card's
current-version action uses that explicit digest when viewing or resuming content.

CAPABILITIES and CENTRAL_SKILLS_ENABLED=1 enable these optional surfaces.
Development and production source configurations include both. See [release status](../release-readiness.md) for deployment and upgrade steps. Central
discovery revalidates the client credential; a failed lookup preserves native
tools. Native-only calls do not resolve central storage. Native Runner access is
independent and is never granted by Skill content, allowed-tools or annotations.

## Content and storage bounds

SKILL.md requires string-valued name and description frontmatter. The YAML core
parser accepts quoted and multiline scalars, collections and additional metadata.
It validates an 8 KiB, 512-node, depth-eight syntax tree before conversion;
aliases, explicit tags, merge keys, duplicate keys and prototype keys are rejected.
Names use lowercase letters, digits and internal hyphens, up to 64 UTF-8 bytes.
The content digest binds the stored metadata and files. Existing bundles retain
their original metadata and digest when verified after parser changes.

Installation stores UTF-8 text collections. A file object contains only path and
text. Relative paths are checked for traversal, empty segments, Windows reserved
names/streams, backslashes and case-folding collisions. Limits are 256 files,
1 MiB per file, 8 MiB per canonical bundle, 12 MiB per admin upload, 32 versions per
Skill, 1,000 Skills and 256 MiB of stored bundles. Cleanup is an explicit lifecycle
operation described below. Reinstalling an existing digest preserves its content
row and creation time.

File sizes count UTF-8 bytes. Capacity reports logical bundle bytes, including
JSON encoding and metadata. Cloudflare physical storage and billed usage are
separate metrics. The browser receives upload limits from the server contract.
File content occupies separate rows below SQLite's row limit. Schema-2 content
retains its digests, revisions and publication state; lifecycle metadata is held
in auxiliary tables understood by the new lifecycle store.

## Fixed GitHub source

POST `/admin/central/skill-source/preview` accepts
`{source:{repository,commit,path},expected_revision:0}`. `repository` is a public
`https://github.com/owner/repo` URL, `commit` is a full 40-character lowercase
commit SHA, and `path` is a Skill folder or an empty string for the repository root.
The platform reader checks the exact commit and reads at most 32 text files.
The selected folder path has at most eight components; each tree response has
at most 2,048 entries and 512 KiB of metadata. The operation deadline is 25 seconds. Normal file and
bundle limits also apply. Symlinks and submodules are rejected.

Preview returns `{state:"previewed",source,bundle}` without storing content.
POST `/admin/central/skill-source/install` accepts the same source, the previewed
`digest`, and the current `expected_revision`. Installation fetches the fixed
source again, verifies the preview digest, then uses the normal atomic installation
transaction. A changed revision yields a conflict. The source URL stored in the
bundle identifies the commit and folder; source fetching has its own platform port.

## History, comparison, retention and cleanup

Lifecycle routes live beneath `/admin/central/skills/{skill_id}`. They share the
administrator session, same-origin CSRF boundary and existing Skill head revision.
Application policy uses a repository port; SQL transactions remain in the platform
store. Reads of history load summaries and counts rather than file bodies.

| Route | Input | Result |
| --- | --- | --- |
| GET `/versions` | — | Head, up to 32 version summaries, timestamps, retention flags and capacity |
| POST `/compare` | `before`, `after` digests | Changed files and metadata at one revision |
| POST `/retention` | `digest`, `pinned`, `expected_revision` | Updated retention flag and head |
| POST `/cleanup-preview` | Exact `digests` array, `expected_revision` | Session-bound five-minute plan with fingerprint and logical bytes |
| POST `/cleanup` | `fingerprint`, `expected_revision`, `confirm:true` | Deleted digest set, freed logical bytes, updated head and capacity |

Comparison verifies both stored bundles and rechecks authorization and revision
before returning. The changed-file list is complete; displayed text is bounded
to 16 KiB per file side, 128 KiB total and 2,048 lines. Truncation flags direct
the UI to retained full files. Metadata differences include name, description,
source, license and declared dependencies.

Every successful retention or cleanup advances the head revision. Cleanup protects
the active digest, the staged/latest-upload digest and pinned versions, including
the active digest of a paused Skill. A preview preserves the exact selection;
one protected or missing member rejects the whole selection. Each Skill has one
stored cleanup plan, replaced by the next preview and tied to its administrator
session. Confirmation atomically rechecks the revision, session, expiry, digest
set, byte total and current protection flags, deletes files and metadata, advances
the head and consumes the plan. The operation uses no periodic cleanup alarm.

Restoring a retained version uses the existing `activate` action with that digest
and the current revision. The original content digest remains unchanged.
`created_at_ms:null` denotes older versions whose installation time was never
recorded; the UI omits the time instead of inventing one. The optional
`skill_version_metadata_v1` and `skill_cleanup_plans_v1` tables leave core schema 2
and immutable bundle contents intact.

Lifecycle failures use `skill_lifecycle_*` codes and an `operation_state` of
`not_started` or `unknown`. After an unknown write result, refresh history before
another change. The browser validates receipts and clears stale confirmations
after selection changes, refreshes or errors.

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

Reading SKILL.md also returns `files:[{path,bytes,sha256}]` for the complete bundle.
Each SHA-256 covers the original UTF-8 file text and each size is its UTF-8 byte
length. Attachment reads return the selected text; consumers keep the same bundle
digest throughout. File hashes use the existing digest port and stop when the
operation is aborted. MCP resource reads expose the same manifest as
`_meta["runmesh/files"]` and dependency status as `_meta["runmesh/dependencies"]`.

MCP resources use the same live checks at
runmesh-skill://bundle/{skill_id}/{digest}/{path}. resources/list walks all bounded
pages and advertises SKILL.md; it rejects failed or looping pagination rather
than returning partial success. Attachments are read on demand. Identity and
publication changes during a read withhold the content. Scripts remain text.

## Dependency metadata

An optional runmesh.json text sidecar contains schema_version: 1 and
requiredCapabilities, at most eight exact CapabilityTarget objects (kind,
resource_id, version, and connection_profile_id for remote_tool). This is a
Runmesh extension, not standard Skill frontmatter. It participates in the digest.
Validation checks exact fields, unique entries and the `skill`/`remote_tool` kinds.

skill_list exposes declarations; skill_read reports configured, not_configured,
disabled, incompatible or unavailable using shared publication metadata.
An active Skill dependency must match its exact declared digest. These advisory
checks do not establish upstream reachability or OAuth validity, install or
enable dependencies, execute tools, recursively load content or add permissions.
Actual calls independently perform their current admission checks.

## Verification boundary

Local domain, SQLite, Worker/Registry/MCP and browser tests exercise publication,
revision conflicts, old digest rejection, two clients without grants, no grant storage, credential revocation, >128 heads, empty pages, resources
parity, path rejection, no-body listing and unchanged native scope boundaries.
Lifecycle fixtures cover 32-to-33-version capacity, explicit cleanup recovery,
active/staged/pinned protection, preview replacement and expiry, concurrent
install/activation/retention, receipt validation and transactional rollback.
Source fixtures cover exact commits, bounded traversal and preview-to-install
consistency. Check the current verification report alongside
[real-host rollout evidence](../central-rollout.md) before release.
