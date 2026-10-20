# Release status

[简体中文](release-readiness.zh-CN.md) · [Documentation](README.md) · [Release notes](release-notes.md) · [Upgrade guide](upgrading.md)

## Current status

**Runmesh 0.2.0 is the current stable release.** The signed Runner package has been published and independently verified. Use the authenticated Runner enrollment page to install a new host, or follow the [upgrade guide](upgrading.md) for an existing installation. Before using the hosted installer, confirm that your Worker reports `distributable: true` at `/runner/releases/stable`. See the [v0.2.0 release](https://github.com/aloneio/runmesh/releases/tag/v0.2.0).

Release activation is bound to the reviewed source commit and manifest digest recorded in `release/release-state.json`; it is never inferred from the version string alone.

Version 0.2.0 adds friendly Skill names, permanent deletion records, clearer MCP status and Runner-management improvements. See the [release notes](release-notes.md).

| Your task | Next step |
| --- | --- |
| Set up a new instance | Follow the [administrator guide](admin-guide.md). |
| Add a computer | Open **Runner → Add Runner** and run the generated installation command on that machine. |
| Connect an MCP or install a Skill | Read the [MCP and Skill guide](central-administration.md). |
| Update an existing installation | Follow the [upgrade guide](upgrading.md), then refresh the AI client's Runmesh connection. |
| Install a downloaded Runner package | Follow the [portable installation guide](portable-runner-installation.md). |
| Try upcoming changes | Use the separate [development channel](dev-runner-prereleases.md). |

Compatible upgrades preserve existing connections, Runners, workspaces and credentials. Read the release notes and upgrade guide before updating.

Maintainers can follow the [publication and activation workflow](maintainers/release-process.md).
