# Services and Skills in the control panel (development)

[简体中文](central-administration.zh-CN.md)

Open /admin/central using the existing browser session. The page provides direct
MCP connection, Skill installation, tool review and client access. There is no
advanced JSON console in the product UI. Internal revisions are carried by the
application; conflicting or unknown writes are never automatically replayed.

## Getting started

1. Enter a public HTTPS MCP URL. Choose No authentication or OAuth; the service
   name is optional. No endpoint list, environment JSON or Runner is needed.
2. For OAuth, Runmesh discovers the provider and uses its client metadata document
   support or dynamic client registration, then opens the service authorization
   page. The callback returns to the control panel and discovers tools. Providers
   that require manual preregistration are not automatically connectable.
3. Review the discovered tools and approve the ones you want to share. OAuth
   connects an instance-admin account; each AI client still needs explicit access.
4. Select SKILL.md and supporting text files, or a Skill folder, and click Install
   Skill. Name and description come from frontmatter. A duplicate name shows an
   explicit update confirmation. Files are saved without executing scripts.
5. Create an AI connection, save its one-time URL, and choose its services and
   Skills under Client access. No Runner is needed for these capabilities.

Installed Skill updates retain old pinned client grants until explicitly changed.
Tool changes need fresh review. OAuth can be reconnected or disconnected from a
service card; credentials never appear in read APIs. Each connection accepts only
its saved public HTTPS destination, with no redirects or private-network routing.

OAuth token encryption is an instance deployment concern. The development
setup:secrets command provisions a separate random vault key when missing and
preserves an existing keyring. No-auth services and Skill installation do not need
that vault. Real third-party account consent and AI-host acceptance remain
provider-specific checks; mock regressions do not claim those external outcomes.

## Shared configuration and grants

GET /admin/central/profiles returns at most 50 credential-free profiles. Supply
after from next_after to continue; every page independently checks the admin
session. Profile secrets are write-only and the legacy credential form clears submitted
credential input. Legacy profile/catalog/OAuth routes remain available for compatibility. Managed connections explicitly carry authentication none or oauth; a legacy null credential never becomes anonymous.

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
the central binding and the selected profile’s egress authorization are valid. The stable rm_ aliases and
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
