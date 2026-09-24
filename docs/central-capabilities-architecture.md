# Central MCP and Skill foundations

W04 directory implementation and its explicit support limits are documented in
[Central catalog review](central-catalog.md). W05 adds the separately gated
[controlled HTTP discovery and invocation](central-remote-mcp.md). Skill loading
and production activation remain later milestones.

[简体中文](central-capabilities-architecture.zh-CN.md)

**Status: development foundations; not an enabled product feature.**
This decision starts the 2026-09-24 W00–W11 plan on `dev`, based on
`f25486b46aa14f3f63097af6a91a88101f5041ca`. It does not announce a release,
an upstream MCP integration, an installed Skill, or a deployment.

## Decision and ownership

One client connection will expose three independently implemented paths:
native Runner tools, centrally connected remote MCP tools, and central Skill
content. The client remains responsible for reasoning and composing calls.
Central tools and Skill reads must not require a selected or online Runner.
They are not installed on each execution machine.

Keep the existing native tool names, schemas, catalog fingerprint and
Worker–Runner protocol unchanged. Do not route central operations through
`activeRunnerTool`, convert them into native Jobs, store Skills in Context, or
copy remote content into the original Runner-only audit envelope.

| Boundary | Owner | Prohibited dependency |
| --- | --- | --- |
| Identity and native permissions | Existing Registry authentication | Central storage as a prerequisite to native authentication |
| Central grant evaluation | `domain/capabilities` and `application/capabilities` | Runner selection, concrete SQL or SDKs |
| Central grant persistence | `platform/capabilities` | Registry tables, Runner state or audit fallback |
| Remote MCP adaptation | Future `platform/connectors` | Skill implementation and host process execution |
| Skill content | Future Skill domain/application/platform modules | Automatic execution, permission grants or Runner Context |
| Public providers | Future thin `mcp/providers` adapters | Application implementations, storage and credential pools |
| Composition | HTTP/entry layer | Duplicated permission rules |

Interfaces live in `contracts/`. The composition layer supplies small ports;
no general dependency-injection framework or universal plugin executor is
introduced. Each feature's internals are private to that feature. Native
modules may not import central implementations outside composition.

## Enforced architecture rules

`scripts/central-architecture-policy.mjs` supplements, rather than replaces,
the existing layer and runtime/type-cycle checks. Connector and Skill internals
cannot import one another. Pure rules cannot import SDKs, Worker environment
types, storage implementations or the Runner wire package. New unreviewed
top-level central directories are rejected, including modules without imports.

AST checks additionally reject direct platform-global I/O in pure central
contracts/rules and direct dynamic code evaluation in central modules.
These checks are conservative maintenance gates, not an operating-system
sandbox or a proof against arbitrary obfuscation. Tests cover both forbidden
dependencies and a valid composition/port path.

## Versioned identity without automatic grants

`ClientIdentity` version 2 separates `native_scopes` from credential identity.
An empty native scope list is valid only in an explicit version-2 identity.
It does not grant access to any central tool, Skill or machine.

There remains one credential record and one authentication implementation.
Legacy nonempty scope arrays keep their existing behavior. Explicit v2 records
store `{schema_version: 2, native_scopes: [...]}` in the existing scope column;
malformed arrays, unknown versions and unexpected persisted fields fail closed.
No core namespace, table or credential is migrated or reset.

The internal client-creation and verification routes accept an explicit
`identity_version: 2`. Legacy creation still rejects empty scopes. Versioned
verification is projected into the existing MCP adapter without changing its
tool schemas. Rotation, revocation and generation checks apply to both forms.
The native RPC admission chain remains unchanged and denies empty native scopes.
Central UI provisioning is a later W08 deliverable, not part of this batch.

**Rollback boundary:** old Worker code does not understand v2 stored identity
objects and rejects those new identities. Existing legacy clients continue to
work. Do not claim new v2 identities work after an old-code rollback; do not
reset the database or silently convert them into machine permissions.

## Central grants and optional state

Grant rules match an exact client, resource kind, stable resource ID and
approved content digest. Remote-tool rules additionally bind a connection
profile ID. There are no wildcards, implicit grants from coding scopes, or
permissions derived from Skill text or tool annotations.

`createCapabilityAccess` performs bounded identity/grant observations and checks
identity again after reading the independent grant owner. Its result is not a
reusable dispatch ticket. Future invocation code must revalidate the relevant
identity and grant revision after queue/connection waits; cross-owner or
in-flight cancellation is not an atomic transaction.

`CapabilitiesDOv1` is the reviewed central composition root in `capabilities-do.ts`,
with no public Durable Object fetch API. The Worker has a separately protected
browser-admin JSON route; the repositories do not import one another.
Its grant repository owns lazy, atomic schema initialization and revision-checked
writes. Unknown, partial or foreign state is rejected without clearing data.
Concurrent writes require the observed revision. Disabling retains the record
and advances its revision instead of deleting history.

Only the **test** Wrangler environment binds this class in this batch.
Production and development deployment bindings, migrations and required secrets
are unchanged. Native requests do not resolve central state or read vault keys.
The disabled access factory does not resolve ports or create timers.

W03 now includes a bearer-credential backend: versioned connection profiles,
AES-256-GCM envelopes, a bounded deployment keyring, a ciphertext-only repository,
and protected profile management. WebCrypto is confined to the connector adapter;
application rules receive narrow authorization, cipher and storage ports.
`SecretVault.withCredential` remains a contract for the later invocation adapter.
There is no plaintext-read API, OAuth implementation or automatic key provisioning.

The protected route is `/admin/central/profiles/{profile_id}`. GET returns safe
metadata. POST accepts only create, rotate, enable, disable and rekey commands.
It requires an administrator session, same origin and the matching CSRF header
and cookie. It has no ADMIN_TOKEN fallback. Session checks occur after body reads
and again in the owner after crypto waits, immediately before the synchronous
revision-checked write. Unknown/malformed receipts never become success or a
reflected error string. A post-dispatch timeout remains an unknown outcome.

New profiles are disabled. Connector identity and destination cannot be changed
by rotation. Ciphertext authenticates the owner namespace, profile, connector,
endpoint, secret generation and key ID. A fresh random IV is used per encryption.
Only ciphertext and metadata enter SQLite. Keys are non-extractable after import;
temporary byte arrays are cleared, but JavaScript strings cannot be reliably
zeroized. This protects stored values, not a compromised Worker runtime.

To rotate a vault key, add a new independent random key to CENTRAL_VAULT_KEYRING,
select its ID, explicitly rekey profiles, and retain old keys until all referenced
envelopes have been verified. Rekey advances the secret generation; enable/disable
does not decrypt and still works with unavailable keys. Removing an old key early
makes remaining envelopes unreadable; it does not authorize fallback to control
secrets, fake values or automatic rewriting. No deployment secret was changed by
this implementation. See Cloudflare's WebCrypto and Worker secrets documentation.

Profile URL checks currently validate credential-free HTTPS syntax and bounded
canonical URLs; they do not establish outbound DNS/SSRF safety. No upstream
request is made in W03. The reviewed egress adapter and capability admission are
still mandatory before a profile can be used to invoke an upstream service.

## Initial enforced budgets

| Item | Ceiling | Enforcement |
| --- | --- | --- |
| Native scope representation | 1,024 characters | Stored identity decoding |
| Rules per client | 128 | Grant parsing |
| Encoded grant | 65,536 bytes | Grant parsing and stored-read bounds |
| Grant records per state owner | 1,000 | Create admission; existing disable remains available |
| One access observation | 5,000 ms | Abortable request-local deadline, no recurring timer |
| Profile records per owner | 1,000 | Create admission; existing profiles can still be disabled |
| Bearer credential | 4,096 ASCII bytes | Closed bearer-token grammar; no header injection |
| Admin command body | 16,384 bytes | Streaming body cap before parsing |
| Keyring | 4 keys / 4,096 characters | Independent versioned keys, no control-secret reuse |
| Profile operation | 5,000 ms | Recheck deadline after each awaited dependency |

These are initial safety ceilings, not measured production capacity. Upstream
discovery, schema complexity, result bytes, connection concurrency and Skill
bundle budgets must be implemented before W04/W05/W07 are enabled. An audit
failure must not become permission to replay a mutation or store secrets.

## Evidence and remaining work

Tests are separated into identity decoding, HTTP/Registry identity behavior,
port-injected grant evaluation, real local DO storage, and architecture fixtures.
Keep native catalog/contract and full regression tests alongside them.

W00's original dirty checkout is preserved; development uses a separate checkout
on `dev`. The observed host-catalog mismatch and native Git environment issue
remain open acceptance items. A local HTTP SDK test does not prove the current
chat host refreshed its tool list. They block enabling the corresponding live
feature, not isolated development of the foundations.

W01 feature gates and W02 identity foundations are implemented here. W03 provides
grant state, encrypted credential profiles and protected administration, not an
enabled upstream integration. Its local tests include HTTP session/CSRF checks,
rekey/tamper scenarios, rollback of failed storage writes, and unknown-schema
preservation. Live activation and real-host acceptance remain separate gates.
W04 supplies imported catalog snapshots, reviewed per-profile selections and an
ACL-filtered reader. W05 adds controlled stateless HTTP discovery and invocation,
with optional remote_tools/remote_call provider registration. It remains disabled
in deployed environments. W06 adds [client-bound OAuth and ephemeral legacy sessions](central-oauth.md),
with explicit provider pins and no persistent shared session. Cross-profile named
toolsets, Skill content, UI, full cost/receipt acceptance, real-client validation
and rollout remain.
The default native tools/list is unchanged. No deployment or automatic upgrade
is part of this decision.
