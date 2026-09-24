# Central MCP and Skill foundations

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

`CapabilitiesDOv1` is a thin internal state adapter with no public HTTP API.
Its grant repository owns lazy, atomic schema initialization and revision-checked
writes. Unknown, partial or foreign state is rejected without clearing data.
Concurrent writes require the observed revision. Disabling retains the record
and advances its revision instead of deleting history.

Only the **test** Wrangler environment binds this class in this batch.
Production and development deployment bindings, migrations and required secrets
are unchanged. Native HTTP composition does not load or invoke central state.
The disabled access factory does not resolve ports or create timers.

`SecretVault` and `ConnectionProfile` are contracts only. No plaintext vault,
temporary credentials, OAuth implementation or production secret backend is
provided. W03 is incomplete until protected composition, encrypted secret
storage, credential generations and activation/migration acceptance are ready.

## Initial enforced budgets

| Item | Ceiling | Enforcement |
| --- | --- | --- |
| Native scope representation | 1,024 characters | Stored identity decoding |
| Rules per client | 128 | Grant parsing |
| Encoded grant | 65,536 bytes | Grant parsing and stored-read bounds |
| Grant records per state owner | 1,000 | Create admission; existing disable remains available |
| One access observation | 5,000 ms | Abortable request-local deadline, no recurring timer |

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
grant evaluation/state and credential ports, not a completed central service.
W04–W11 remain pending: approved upstream catalogs, remote invocation, OAuth,
Skill content, UI, complete fault/cost acceptance, client validation and rollout.
Do not present the current native `tools/list` as already containing these
future tools. No deployment or automatic upgrade is part of this decision.
