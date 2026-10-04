# Services and Skills in the control panel (development)

> Maintainer reference: interfaces, protocol and verification boundaries. For everyday use, see the [user guide](../central-administration.md).

[简体中文](central-administration.zh-CN.md)

## Connect, publish and use

Open /admin/central with your administrator browser session. Enter a public HTTPS
MCP URL and select No authentication or OAuth. The service name is optional.
When omitted, the name is derived from the hostname and shortened to fit its
display limit; the saved MCP URL remains complete.
OAuth settings are discovered automatically; providers requiring manual client
preregistration are not automatically connectable. The saved service is displayed
before opening OAuth, so a failed sign-in handoff retains its recovery controls.
After signing in, return to
the control panel. A successful connection discovers and publishes every tool
atomically; no separate approval is required. Existing enabled connections with
unpublished tools finish on opening the library. View tools is read-only; Refresh
tools updates the shared catalog immediately. Resuming a paused service refreshes
its tools automatically.

An unavailable pending service does not block other connections. Recovery reports
each failed service and refreshes the library before a different service can
write; it never retries the failed connection in the same pass. If that refresh
fails, recovery stops. Returning from OAuth also resumes other pending services.
Ready-to-use messages require the refreshed service to remain enabled and its
complete tool catalog to remain published.

Select SKILL.md and supporting text files, or a complete Skill folder, to install
a Skill. Its name and description come from frontmatter. Installing saves,
approves and activates the files atomically; scripts never execute. Replacing
an installed Skill requires confirmation and the currently observed revision.
The success message also verifies that the installed version is still active
after refresh; a concurrent pause or replacement is reported instead.

Create an AI connection and copy its one-time URL into the AI client. Every valid
authenticated client in the instance shares all enabled published MCP tools and
active Skills. There is no Client access tab, individual assignment, reusable
grant template or advanced JSON console. No Runner is needed for these features.
Clients may need to refresh their tool or Skill list after publication changes.

## Shared access

All valid clients use the shared library. Per-client grants, toolset assignment,
client-bound OAuth and manual bearer profile APIs are removed. Their routes return
the ordinary HTTP 404 unknown-route response without resolving the state owner.
This development feature has no legacy compatibility layer.

Revoke or rotate a client's connection credential to stop that credential from
being used. Pause a service or Skill to stop sharing that capability with every
client. For separate capability trust boundaries, use separate instances.
Native computer scopes and Runner/workspace permissions remain independent;
sharing central capabilities never creates machine access.

Updates publish the active Skill version to all clients. A cached old digest is
rejected; refresh skill_list and use its new digest for every attachment. Old
bundles remain available to administrators for explicit rollback. Disabling or
revoking access cannot erase content already delivered to a client's context.

## Publication, identity and connection boundaries

Successful discovery publishes the complete catalog in one revision. Failed or
partial discovery preserves the current publication. Stale tool schemas require
a refresh; invoking a tool does not change its catalog or replay the operation.
Each call revalidates client identity, enabled profile, published catalog, content
version and credential state before dispatch
and again before returning output. An upstream action may already have executed
when a later check withholds its result; that does not mean it was rolled back.
Unknown or conflicting outcomes are never automatically replayed.

Upstream OAuth consent remains required for OAuth services. Reconnect or
disconnect the upstream account from its service card. OAuth credentials remain
available across a pause/resume of sharing; old in-flight leases stay invalid,
and an explicitly disconnected account still requires fresh sign-in. They remain
encrypted and absent from read APIs. Managed connections accept only their saved
public HTTPS destination, without private-network routing or redirects. OAuth
encryption uses the existing deployment secret without an additional variable.
Upstream credentials are managed through the OAuth connection lifecycle.

GET /admin/central/profiles returns up to 50 credential-free profiles; use
next_after as after to continue. Each page checks the administrator session.
Mutations require same-origin session/CSRF admission and exact revisions.
Failed refreshes invalidate pending confirmations and block further writes
until the library refresh succeeds.
Confirmed input-validation rejections let you correct the service URL/name or
Skill files and submit again without refreshing the library. This does not retry
the request automatically; uncertain writes and revision conflicts still require
a refresh. Controls remain disabled throughout an active operation, including
cards recreated by an intermediate refresh.

## Discovery and optional governance

remote_profiles lists the bounded shared service directory. remote_tools reads
published tools for its profile_id with cursor pagination; remote_call invokes
one exact tool/version. CENTRAL_DIRECT_TOOLS_ENABLED=1 also publishes direct rm_
aliases with their published schemas, bounded to eight profiles and 32 tools.
Larger libraries use remote_profiles, remote_tools and remote_call; they are not
silently truncated. Discovery never contacts upstream services.

Connecting or refreshing a service closes any operation-scoped upstream session
before publishing its discovered tools, then rechecks authorization and revisions.
This prevents publication's own version change from blocking session cleanup.

CENTRAL_SKILLS_ENABLED=1 exposes skill_list, skill_read and the matching MCP
resource surfaces. skill_list scans at most 128 heads per page and returns
next_after; continue even when a page contains no active Skills.

CENTRAL_GOVERNANCE_ENABLED=1 enables bounded durable call budgets, cooldowns and
metadata receipts. Receipts exclude arguments, results and credentials. Audit
failure does not replay calls or change completed results. This is not a billing
system or a promise of distributed rate limiting.

Browser checks cover immediate availability, OAuth
callbacks, Skill updates, stale confirmations, failed refresh and no replay.
Real supplier consent, two real AI hosts and production promotion require the
separate evidence in [the rollout ledger](../central-rollout.md).
