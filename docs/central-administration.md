# Services and Skills in the control panel (development)

[简体中文](central-administration.zh-CN.md)

## Connect, publish and use

Open /admin/central with your administrator browser session. Enter a public HTTPS
MCP URL and select No authentication or OAuth. The service name is optional.
OAuth settings are discovered automatically; providers requiring manual client
preregistration are not automatically connectable. After signing in, return to
the control panel, review discovered tools and approve the ones to publish.

Select SKILL.md and supporting text files, or a complete Skill folder, to install
a Skill. Its name and description come from frontmatter. Installing saves,
approves and activates the files atomically; scripts never execute. Replacing
an installed Skill requires confirmation and the currently observed revision.

Create an AI connection and copy its one-time URL into the AI client. Every valid
authenticated client in the instance shares all enabled published MCP tools and
active Skills. There is no Client access tab, individual assignment, reusable
grant template or advanced JSON console. No Runner is needed for these features.
Clients may need to refresh their tool or Skill list after publication changes.

## Shared access and migration

Existing valid clients also use the shared library. Stored legacy grant rows,
including disabled or restrictive rows, no longer affect listing or invocation.
GET/POST /admin/central/grants/{client_id} and /admin/central/toolsets/{toolset_id}
return HTTP 410 with central_client_access_retired and perform no owner mutation.
Old rows are retained as archival data; they are not a hidden default ACL.

Revoke or rotate a client's connection credential to stop that credential from
being used. Pause a service or Skill to stop sharing that capability with every
client. For separate capability trust boundaries, use separate instances.
Native computer scopes and Runner/workspace permissions remain independent;
sharing central capabilities never creates machine access.

Updates publish the active Skill version to all clients. A cached old digest is
rejected; refresh skill_list and use its new digest for every attachment. Old
bundles remain available to administrators for explicit rollback. Disabling or
revoking access cannot erase content already delivered to a client's context.

## Review, identity and connection boundaries

Tool publication remains explicit. Newly discovered or changed tool definitions
are quarantined until reviewed; stale schemas cannot be called merely because
the instance uses shared access. Each call revalidates client identity, enabled
profile, reviewed catalog, content version and credential state before dispatch
and again before returning output. An upstream action may already have executed
when a later check withholds its result; that does not mean it was rolled back.
Unknown or conflicting outcomes are never automatically replayed.

Upstream OAuth consent remains required for OAuth services. Reconnect or
disconnect the upstream account from its service card. OAuth credentials remain
encrypted and absent from read APIs. Managed connections accept only their saved
public HTTPS destination, without private-network routing or redirects. OAuth
vault setup is an instance deployment concern; no-auth services and Skills do
not require it. Legacy bearer profiles retain write-only credential rotation.

GET /admin/central/profiles returns up to 50 credential-free profiles; use
next_after as after to continue. Each page checks the administrator session.
Mutations require same-origin session/CSRF admission and exact revisions.
Failed refreshes invalidate pending confirmations and block further writes
until the library refresh succeeds.

## Discovery and optional governance

remote_profiles lists the bounded shared service directory. remote_tools reads
reviewed tools for its profile_id with cursor pagination; remote_call invokes
one exact tool/version. CENTRAL_DIRECT_TOOLS_ENABLED=1 also publishes direct rm_
aliases with their reviewed schemas, bounded to eight profiles and 32 tools.
Larger libraries use remote_profiles, remote_tools and remote_call; they are not
silently truncated. Discovery never contacts upstream services.

CENTRAL_SKILLS_ENABLED=1 exposes skill_list, skill_read and the matching MCP
resource surfaces. skill_list scans at most 128 heads per page and returns
next_after; continue even when a page contains no active Skills.

CENTRAL_GOVERNANCE_ENABLED=1 enables bounded durable call budgets, cooldowns and
metadata receipts. Receipts exclude arguments, results and credentials. Audit
failure does not replay calls or change completed results. This is not a billing
system or a promise of distributed rate limiting.

Local browser checks use no screenshots and cover connection/review, OAuth
callbacks, Skill updates, stale confirmations, failed refresh and no replay.
Real supplier consent, two real AI hosts and production promotion require the
separate evidence in [the rollout ledger](central-rollout.md).
