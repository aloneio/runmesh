# ADR 0002: Skill maintenance and MCP discovery

Status: accepted.

## Context

Runmesh exposes shared Skills and remote MCP services through one authenticated control plane. The design must keep content immutable, preserve bounded storage and request costs, separate discovery from execution authority, and avoid turning external metadata into trusted configuration.

The current implementation includes Skill version/capacity maintenance, bounded YAML frontmatter parsing, fixed-commit GitHub Skill import, read-only MCP connection inspection, `server.json` preview and deterministic published-tool search. Runner diagnostics report unobserved platform checks as unknown rather than claiming success.

## Decisions

- Keep one immutable Skill content store and one head revision. History reads summaries; comparing or opening files loads only the chosen versions.
- Keep optional version timestamps and pins in adjacent metadata. Existing content digests remain independent of parser evolution.
- Preview cleanup against an exact digest set, head revision, administrator session and bounded expiry. Confirmation rechecks the plan in the content owner's synchronous transaction; active, staged and pinned versions remain protected.
- Parse bounded YAML in the Skill domain layer. Preserve delivered UTF-8 file bytes, derive manifests on demand and never change a bundle digest because parsing rules evolve.
- Import public GitHub content only at a full commit SHA through the dedicated fixed-host source adapter. Preview and installation resolve the same commit; installation rechecks the reviewed bundle digest and current head revision.
- Inspect remote MCP services through the guarded transport using read-only initialization and tool-listing operations. Inspection does not publish tools or grant execution authority.
- Treat imported Registry `server.json` data only as form metadata. Previewed candidates populate the ordinary connection workflow; they do not modify an existing connection or install software.
- Search current published snapshots through narrow read ports. Ranking is deterministic, bounded and request-local. Results retain profile, exact tool ID and version; authorization and publication are checked again before return.
- Keep browser controllers responsible for shared busy/refresh state. Separate workflows own Skill history, source preview, connection inspection and Registry import. Pure receipt validation stays outside DOM modules.

## Prerequisite-bound extensions

Client-specific Skill protocol extensions, a periodically refreshed external MCP directory, stdio hosting, execution backends, artifact/workflow services, Tasks, client OAuth and finer sharing policies are separate product decisions. They are not implied by this ADR and must not be treated as unfinished work without a current requirement, threat model and resource budget.

## Verification and rollback

Regression coverage includes version-capacity limits, cleanup recovery, concurrent publication/pinning, transaction rollback, bounded YAML, fixed-source provenance and byte limits, read-only inspection, search authorization and browser confirmation invalidation. CI results and live-provider receipts belong in bounded CI artifacts or the external evidence store, not in source control.

Do not assume an older runtime can parse content installed by a newer parser. Before downgrading, validate the target runtime against retained Skills and keep an independent database backup. Confirmed deletions require an external retained copy for restoration.
