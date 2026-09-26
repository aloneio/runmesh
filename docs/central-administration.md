# Central administration and governance (development)

[简体中文](central-administration.zh-CN.md)

The /admin/central page opens the Services & Skills library using the existing
browser session, CSRF, strict cookies and CSP. Forms and explicit checkboxes guide
service connections, tool review, Skill import/publication and client access. The
interface carries the reviewed revisions and content versions. Failed or unknown
mutations are never automatically retried. OAuth, reusable toolsets and raw API
operations remain in the collapsed Advanced diagnostics section.

## Getting started

The homepage leads with capabilities and AI connections. Computer access is an
optional section, so a service-only user does not start with Runner setup.

1. The instance administrator configures approved service addresses and secure
   credential storage once. Until ready, service creation stays disabled and the
   page explains why. When enabled, the Skill library remains independently usable.
2. Select an approved MCP service, name it and enter its upstream access token.
   Review and explicitly approve the discovered tools. Update credentials from
   the service card; submitted token fields are cleared.
3. Import SKILL.md with its supporting text files or its folder, and record the
   source and license. Preview makes no writes. Publication requires review and
   confirmation; uploaded scripts remain text and never execute on the server.
4. Create an AI connection. Services and Skills are the default, with no Runner
   required. Save the one-time URL, then follow Choose services and Skills to
   manage that exact connection's permissions.
5. Add the URL as a remote MCP connection in your AI client. Refresh its tools
   after access changes. Routine users need no environment variables or JSON.

Access choices use published Skill metadata, even when a newer draft exists.
Older pinned grants remain visible and are removed only when explicitly unchecked.
Conflicts and failed library refreshes require a fresh read before further writes.

This is a development administrator library. Guided supplier OAuth onboarding,
visual reusable-toolset management, a public marketplace and real AI-host
acceptance remain unfinished. It is not universal zero-configuration MCP access.

## Shared configuration and grants

GET /admin/central/profiles returns at most 50 credential-free profiles. Supply
after from next_after to continue; every page independently checks the admin
session. Profile secrets are write-only and the console clears submitted
credential input. Existing profile/catalog/OAuth routes retain their contracts.

GET/POST /admin/central/grants/{client_id} reads or replaces an exact grant. A
write contains expected_revision, enabled and rules. Every rule references either
an exact remote tool ID/version/profile or a Skill ID/digest. This does not modify
native scopes. An unapproved or unavailable capability remains unusable.

GET/POST /admin/central/toolsets/{toolset_id} manages up to 64 reusable templates.
Use action replace, expected_revision, enabled and rules to save one; action
apply, client_id, toolset_revision and expected_revision applies that exact
template to one client's grant. Repeat only the assignment for another client.
Both source and destination revisions are checked. Editing/disabling a template
does not silently change existing grants: reapply explicitly, or revoke each
client grant. A template is not a live inheritance mechanism.

## Direct versus discovery directories

CENTRAL_DIRECT_TOOLS_ENABLED=1 additionally publishes reviewed direct tools when
the remote binding/egress configuration is valid. The stable rm_ aliases and
exact JSON schemas come from saved, ACL-filtered snapshots. No live upstream
discovery is performed by tools/list. Direct calls and remote_call share the
same runtime validation, generation checks and invocation implementation.
Discovery hides the generic remote entries and direct aliases when the current
client has no enabled remote-tool grant. Skill entry points are independently
filtered by Skill grants. A new directory request reflects revoked grants; a
cached name still requires live authorization when called.

Direct views are bounded to 8 profiles, 32 tools and 512 KiB. Larger views use
remote_tools/remote_call. remote_status distinguishes capacity, denied and
unavailable from an empty successful directory. Central failure preserves native
registration. Native tool calls do not load the direct directory. Host cache
refresh still requires real-host acceptance; a known old alias cannot bypass
current authorization.

## Optional persistent governance

CENTRAL_GOVERNANCE_ENABLED=1 adds owner-local persistent admission and receipts
to remote calls. Existing in-flight concurrency limits remain. Before connecting,
an authorized call must fit 30 requests/client/minute and 120/profile/minute.
At most 2,048 admission keys are retained. Three successive upstream transport,
protocol or uncertain-result failures start a 30-second profile cooldown.
There is no queue, background polling or automatic replay. Disabling this flag
returns to the earlier concurrency-only baseline; it does not delete tables.

Receipts contain only request ID, client ID, profile/tool/version, operation
state, fixed error code and timestamp. They omit parameters, results, bodies,
secrets and fake Runner IDs. A completed call stays completed if receipt storage
fails; runmesh/receipt metadata reports audit_status unavailable. The store keeps
at most 1,000 receipts, with a 24-hour read window and demand-driven expiry cleanup.
GET /admin/central/receipts returns the latest 50 to an authenticated administrator.
There is no client receipt lookup or replay API.

These budgets are safety ceilings, not measured production throughput. The
supported OAuth/session subset remains in [Central OAuth](central-oauth.md);
[Skill content](central-skills.md) has separate opt-in and content limits.
