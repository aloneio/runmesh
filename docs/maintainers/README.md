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
- [Deploy and verify MCP connections and Skills](../central-rollout.md)
- [MCP reauthorization](../mcp-reauthorization.md) and [cost measurement](../cost-baseline.md)

## Legacy compatibility

- [Early-version migration](../legacy-migration.md)

Legacy migration guidance applies only to the explicitly named old data boundary. For current installations, follow the current upgrade guide and release status.
