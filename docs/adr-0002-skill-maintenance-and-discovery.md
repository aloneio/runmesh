# ADR 0002: Skill maintenance and MCP discovery

Date: 2026-10-06. Status: accepted for local development on `dev`.

## Context

The implementation plan dated 2026-10-06 is a reference. The baseline is commit
`97561adf8faeaebd1d68d14bfd09a853da37dade`. Existing request/Job recovery, shared
central capabilities, independent machine permissions, encrypted credential
storage and architecture gates remain the foundation.

The immediate gaps are an incomplete Skill version/capacity workflow, single-line
metadata parsing, manual source downloads, and a lack of read-only MCP connection
inspection and published-tool search. Runner doctor also overstated two checks:
unobserved Windows ACLs and mismatched desired/applied policy revisions.

## Decisions

- Keep one immutable Skill content store and one head revision. History reads
  summaries; comparing or opening files loads only the chosen versions.
- Add optional version timestamps and pins in an adjacent metadata table. Existing
  records retain unknown timestamps. The content schema and original digests stay
  unchanged; stored metadata is verified independently of later parser semantics.
- Preview cleanup against an exact digest set, head revision, administrator
  session and five-minute expiry. Store at most one plan per Skill. Confirmation
  rechecks the same plan inside the content owner's synchronous transaction, then
  removes content and metadata and advances the head revision together. Active,
  staged and pinned versions remain protected. Cleanup has no recurring job.
- Parse bounded YAML data in one domain module using the existing pinned YAML
  dependency. All files retain their delivered UTF-8 bytes. File manifests are
  derived on demand and never change a bundle digest.
- Import public GitHub content at a full commit SHA through a dedicated source
  port and fixed-host adapter. Preview and installation fetch the same commit;
  installation also checks its reviewed bundle digest and current head revision.
  Limits fit a bounded Worker request, with no process execution or new secret.
- Inspect remote MCP services through the existing guarded transport. Inspection
  owns no publication repository and issues only handshake and tools/list calls.
  Report declared capabilities separately from successfully read tool catalogs.
- Treat imported Registry `server.json` as form metadata. Show remote candidates
  and externally hosted packages; using a candidate fills the normal connection
  form. It does not change an existing connection or install software.
- Search current published snapshots through narrow read ports. Ranking is
  deterministic, bounded and request-local. Results retain profile, exact tool ID,
  version and revision. Authorization and publication are checked again before
  return; execution still uses the existing remote-call checks.
- Keep browser controllers responsible for shared busy/refresh state. Separate
  workflows own Skill history, source preview, connection inspection and Registry
  import. Pure receipt validation stays out of DOM modules.

## Scope decisions for the reference plan

| Reference | Decision |
| --- | --- |
| RM-00 | Record the local baseline, adopted scope and verification evidence. |
| RM-01–04 | Preserve existing bounded diagnostics and Job recovery; fix confirmed doctor findings. Additional live cross-product acceptance belongs to a separately observed candidate. |
| RM-05–08 | Implement version/capacity maintenance, bounded metadata/manifest support and fixed-commit GitHub import. |
| RM-09 | Retain current Skill tools/resources. Negotiate the official extension after target client support is verified; the file manifest is ready for that adapter. |
| RM-10 | Add read-only connection inspection using the current transport and authentication authority. |
| RM-11 | Implement individual `server.json` preview. A periodically refreshed external directory needs a measured usage and refresh budget. |
| RM-12 | Add keyword search without a persistent index, upstream fan-out or model API. |
| RM-13–15 | Reuse current deployment/permission UI. Add local workflow, boundary and resource-budget regressions; keep cloud quota claims tied to actual measurements. |
| RM-16 | Local development and validation only for this request. Publication, deployment and release acceptance are separate states. |
| RM-17–23 | Leave stdio hosting, execution backends, artifact services, workflow engines, Tasks, client OAuth and finer sharing policies to their stated product/client prerequisites. |

The proposal to serialize all writes across agents is adapted to disjoint file
ownership with an integrating reviewer. Agents cross-review contracts and changes;
heavy test runs are serialized on the local machine.

## Validation and rollback

Regression coverage includes the 32-version capacity boundary and recovery after
cleanup, concurrent publication/pinning, transaction rollback, session/expiry
checks, unchanged old digests, bounded YAML, source provenance and byte limits,
read-only inspection, search authorization and browser confirmation invalidation.
The verification inventory includes these tests in the existing CI commands.

Schema 2 table structure and stored content digests remain unchanged; the prior
SQL reader can ignore companion metadata tables. This storage compatibility is
separate from application parsing: an older runtime may reparse SKILL.md with
its single-line parser and reject newly installed multiline YAML content.
Runtime rollback to N-1 has not been verified. Before downgrading, validate the
intended target runtime against the retained Skills and its parser capabilities;
keep a database backup for restoring the earlier application state. Already
confirmed deletions require a retained copy to restore. The UI reports logical
content bytes separately from provider billing.

No environment variable, credential store, identity database, background poller or
automatic retry of uncertain writes is introduced by these features.
