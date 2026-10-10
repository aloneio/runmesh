# Maintainer documentation

[简体中文](README.zh-CN.md) · [User documentation](../README.md)

Use these references when developing Runmesh, integrating its APIs or preparing a release.

## Architecture and contracts

- [Architecture](../architecture.md) and [dependency checks](../architecture-gates.md)
- [Architecture decision](../adr-0001-architecture.md), [foundation boundaries](../foundation-boundaries.md) and [protocol](../protocol.md)
- [Runner boundaries](../runner-boundaries.md), [Runner transport](../runner-transport.md) and [Registry domains](../registry-domains.md)
- [Central MCP and Skill architecture](../central-capabilities-architecture.md)
- [Control-panel interfaces](central-administration.md), [MCP transport](central-remote-mcp.md), [OAuth](central-oauth.md) and [Skill storage](central-skills.md)
- [Catalog snapshots](../central-catalog.md), [capability contracts](../capability-contracts.md) and [workspace Context storage](../context-storage.md)
- [MCP output contracts](../mcp-output-contracts.md), [byte pagination](../byte-pagination.md) and [bound cursors](../bound-cursors.md)
- [Administrator view boundaries](../admin-view-boundaries.md) and [UI localization](../ui-localization.md)

## Development and releases

- [Verification workflow](../verification.md)
- [Development Runner channel](../dev-runner-prereleases.md)
- [Protected main promotion](../main-promotion-policy.md)
- [Branch protection](../BRANCH_PROTECTION.md) and [release preflight](../runbooks/release-preflight.md)
- [Publication and activation](release-process.md)
- [Central feature acceptance](../central-rollout.md)
- [MCP reauthorization](../mcp-reauthorization.md) and [cost measurement](../cost-baseline.md)

## Historical records

- [Archived release notes](release-history.md)
- [Dated review evidence](release-evidence.md)
- [Early-version migration](../migration.md)
- [Main production cutover](../production-main-cutover.md) and [legacy Durable Object retirement](../retire-legacy-production-do.md)
- [Correctness review (2026-09-15)](../review-correctness-20260915.md) and [development product review (2026-09-25)](../dev-product-readiness-20260925.md)
- [Optimization ledger](../optimization-ledger.md)

Historical records describe the versions and dates named in each document. For an existing installation, follow the current [upgrade guide](../upgrading.md) and [release status](../release-readiness.md).
