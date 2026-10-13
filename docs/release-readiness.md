# Release status

[简体中文](release-readiness.zh-CN.md) · [Documentation](README.md) · [Release notes](release-notes.md) · [Upgrade guide](upgrading.md)

## Current stable release: 0.1.10

[Runmesh 0.1.10](https://github.com/aloneio/runmesh/releases/tag/v0.1.10) is available with a signed portable Runner package. This release keeps cancellation consistent through the final stage of Runner maintenance and release downloads, so an interrupted update retains its result and can be retried safely. See the [release notes](release-notes.md) for the changes.

The 0.1.9 package remains available from [GitHub Releases](https://github.com/aloneio/runmesh/releases) for installations that need that version.

| Your task | Next step |
| --- | --- |
| Set up a new instance | Follow the [administrator guide](admin-guide.md) to deploy the control plane, connect MCPs and install Skills. |
| Add a computer | Open **Runner → Add Runner** and run the generated command on the target machine. |
| Update an existing installation | Follow the [upgrade guide](upgrading.md) to update the control plane and Runner, then refresh the AI client's tools. |
| Install from a downloaded archive | Use the [portable installation guide](portable-runner-installation.md) to verify and install the signed package. |
| Try upcoming changes | Use the separate [development channel](dev-runner-prereleases.md). |

During an upgrade, keep your existing Cloudflare resources, deployment secrets and Runner profiles. These preserve account connections, enrolled machines and workspace settings. Existing installations should refresh the installed version manager before selecting a new Runner version; the [upgrade guide](upgrading.md#update-an-installed-version-manager) describes the steps.

## Check your installed version

The control plane exposes its running version at `/health`. Its `/runner/releases/stable` endpoint lists the stable Runner package selected for that instance. Follow [build provenance](build-provenance.md) to check the deployed source, and the [upgrade guide](upgrading.md) to confirm the Runner service version.

[Runmesh 0.1.9](https://github.com/aloneio/runmesh/releases/tag/v0.1.9) and earlier signed releases remain available from [GitHub Releases](https://github.com/aloneio/runmesh/releases). The upgrade guide includes recovery steps for an existing installation.

Maintainers can follow the [publication and activation workflow](maintainers/release-process.md).
