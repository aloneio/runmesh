# MCP Bootstrap Manifest v1

## Purpose

RunMesh should be usable by an unfamiliar agent without requiring that agent to preload every Runner action, Skill body, or federated MCP tool schema. The bootstrap manifest is a compact machine-readable routing map. It tells an agent what capability classes exist, how deeper capabilities are discovered, and which runtime controls remain authoritative.

The bootstrap manifest is deliberately not a second permission system and not a full tool catalog.

## Phase 1 scope

Version 1 adds one native read-only MCP tool: `bootstrap`.

The tool must:

- work without a selected or online Runner;
- remain readable without coding scopes;
- never grant scopes, workspace permissions, host permissions, or remote MCP authority;
- avoid loading full remote MCP schemas;
- return a stable static routing contract plus bounded live summaries;
- degrade directory sections independently when Registry or Central state is unavailable;
- stay small enough to be suitable for first-contact agent context.

User preferences, workspace policy overlays, and `AGENTS.md` ingestion are intentionally excluded from v1.

## Response contract

The response contains these top-level areas:

1. `schema_version` — breaking response-shape version.
2. `product` — RunMesh identity, release version, and purpose.
3. `usage` — when the manifest should be read and how its static contract may be cached.
4. `capabilities` — supported capability classes. Every capability states that authorization is resolved at runtime.
5. `routing` — recommended tool chains for machine, workspace, job, remote MCP, Skill, and handoff-context tasks.
6. `authorization` — an explicit statement that bootstrap grants no authority.
7. `rules` — compact discovery and mutation-safety rules.
8. `current.runner` — selection and availability summary without exposing a Runner identifier.
9. `directory.remote_mcp` — bounded published service summaries plus the discovery entry point.
10. `directory.skills` — first-page availability metadata plus the discovery entry point.
11. `manifest` — static-contract revision and SHA-256 digest.

The SHA-256 covers only the static routing contract. Product release changes, Runner state, and directory contents do not invalidate the static routing contract.

## Discovery model

External-service tasks use lazy discovery:

`bootstrap -> remote_search -> remote_tools -> remote_call`

If `remote_search` returns no relevant tools, do not conclude that the service lacks the capability. General-purpose MCPs may expose broad tools such as `search` or `execute` whose internal API surface is not represented in the published tool name or description. For a known service, inspect that profile with `remote_tools`; if the service is not yet known, use `remote_profiles -> remote_tools` before deciding the capability is unavailable.

The effective external-service flow is therefore:

`bootstrap -> remote_search -> [remote_tools | remote_profiles -> remote_tools] -> remote_call`

Reusable workflows use:

`bootstrap -> skill_list -> skill_read`

Machine work uses:

`bootstrap -> runner_list / runner_select -> workspace_list -> inspect / read / edit / shell / job`

Workspace handoff state remains separate and continues to use the `context` tool with its `bootstrap` action.

## Runtime authorization boundary

Bootstrap describes support, routing, and current availability only. Runtime authority continues to come from the existing scope, workspace-policy, Runner-policy, and host-OS checks.

A statement such as `shell.supported = true` means the platform supports shell execution. It does not mean the current connection may execute a command.

The manifest therefore includes `bootstrap_grants_permissions = false` and marks capability authorization as `runtime`.

## Dynamic summaries

### Runner

Bootstrap reports only whether a Runner is selected, its coarse connection state, and whether it is currently available. It does not disclose the selected Runner ID, host path, workspace root, or credentials.

### Remote MCP

Published profile summaries are capped at 16 entries. `profile_count` and `profiles_truncated` tell the agent when it should continue discovery through `remote_profiles` or `remote_search`.

Full remote tool definitions and schemas are intentionally excluded.

### Skills

Skill discovery is paginated. Bootstrap therefore reports `page_count` and `has_more`, not a misleading total count. An empty first page with `has_more = true` is `ready`, not `empty`, because later pages may contain active Skills.

## Failure and degradation behavior

Bootstrap is designed to return useful routing information even when optional dependencies are impaired:

- no selected Runner -> `current.runner.selection = none`;
- Registry selection read unavailable -> Runner summary becomes `unavailable`; the rest of bootstrap still succeeds;
- Central capability binding absent -> remote MCP is `disabled`; Skills are `disabled` unless explicitly enabled;
- Central call timeout, invalid response, or rejected identity -> the affected directory summary becomes `unavailable`; bootstrap still succeeds;
- Skill publication disabled -> Skills are `disabled`.

No degradation path may expose host roots, credentials, secret values, command history, remote connection material, or hidden authorization data.

## Size and latency budgets

The serialized v1 response targets a maximum of 8 KiB.

Central summary calls are bounded independently so a slow directory cannot turn bootstrap into a long-running initialization request. Remote services are summarized, not expanded into full tool schemas.

## Implementation plan

### Phase 1 — Bootstrap v1

- define a strict public output schema;
- add the native `bootstrap` tool and handler;
- add the static capability, routing, authorization, and safety contract;
- add bounded Runner, remote MCP, and Skill summaries;
- add static manifest revision and digest;
- keep bootstrap visible to authenticated clients with no coding scope;
- update native catalog compatibility tests;
- add degradation, pagination, size, and authorization-boundary tests.

### Phase 2 — User preferences

Add a separate user-owned configuration model for safe defaults such as preferred Runner, response language, Git identity, and workflow preferences. User configuration must never grant runtime authority.

### Phase 3 — Workspace guidance

Add workspace-scoped machine-readable configuration and optional `AGENTS.md` discovery. Markdown guidance remains advisory and cannot expand scopes or permissions.

### Phase 4 — Effective guidance

Define a deterministic precedence model across system defaults, organization policy, user preferences, workspace configuration, advisory project guidance, and the current user request.

## Acceptance criteria

An unfamiliar agent reading only `bootstrap` must be able to identify the correct next discovery path for:

- selecting and inspecting a machine;
- reading or editing a workspace;
- following a long-running job without relaunching it;
- discovering and invoking a Cloudflare/GitHub-style remote MCP capability;
- discovering reusable Skills;
- resuming workspace handoff context.

Additional v1 acceptance requirements:

- bootstrap succeeds with no selected Runner;
- bootstrap succeeds when Central is disabled or unavailable;
- bootstrap remains readable without coding scopes but does not make restricted native tools executable;
- the response does not contain full remote MCP schemas;
- an empty Skill page with a continuation cursor is not reported as an empty Skill directory;
- the serialized response stays within the 8 KiB budget.
