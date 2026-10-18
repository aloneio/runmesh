<p align="center">
  <img src="./assets/logo.png" alt="Runmesh" width="460" />
</p>

<p align="center"><strong>Give AI clients safe access to the computers you approve</strong></p>
<p align="center">Runmesh is a self-hosted platform that connects AI clients, shared MCPs and Skills to computers you manage.</p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./docs/user-guide.md">User guide</a> ·
  <a href="./docs/admin-guide.md">Administrator guide</a> ·
  <a href="./docs/troubleshooting.md">Troubleshooting</a> ·
  <a href="./docs/README.md">All documentation</a>
</p>

> [!IMPORTANT]
> Runmesh is provided under the PolyForm Noncommercial License 1.0.0. Commercial use requires separate written authorization. See [Commercial License](docs/legal/COMMERCIAL_LICENSE.md).

## See Runmesh in 60 seconds

Runmesh connects ChatGPT, Claude, Cursor and other MCP-compatible clients to approved Linux, macOS or Windows computers. Machines may be behind NAT or on a private network; the AI can use only the content and permissions you grant.

https://github.com/user-attachments/assets/49488721-4a41-40af-a0a6-5482f71b937c

[Download MP4](docs/media/runmesh-promo.en.mp4?raw=1) · [Overview and subtitles](docs/media/README.md)

## What you can do

- Let an AI inspect files, propose edits or run approved commands in selected workspaces.
- Run tests, builds and other long-running work while following progress in the control panel.
- Connect MCPs and install Skills in one place, then share them with several AI clients.
- Give each client shared content only, or add access to approved computers.

A Runner is installed on each computer that performs work. Administrators choose its workspaces and the capabilities each client may use. The default restricted service-account mode is `dedicated_user`; computer permissions start with Read selected.

## Get started

If an administrator has given you a Runmesh address:

1. Paste the complete address into an MCP-compatible AI client.
2. Refresh the client's Runmesh connection to load the shared MCPs and Skills.
3. When computer access is available, choose the intended computer and open an approved workspace.
4. Start by viewing files; use edit, command or job actions only when the client shows that permission.

A Runmesh address is a credential. Store and share it only through a secure channel. See the [user guide](docs/user-guide.md) for the complete workflow.

## Administrator quick setup

1. Deploy the current stable version listed in [release status](docs/release-readiness.md).
2. Open **Runner**, add a computer, copy the one-time installation command and run it on that machine.
3. Add approved workspaces and permissions in the Runner details page.
4. Open **MCP & Skill** to connect shared services and install Skills.
5. Open **AI connections**, create a connection, choose shared content or computer access, and share the displayed address with its intended user.
6. Use the relevant page to update, pause, rotate or revoke access.

Installation commands and client addresses are credentials; keep them private. For an existing installation, preserve its credentials and Runner settings and follow the [upgrade guide](docs/upgrading.md).

## Permissions

| Permission | Use |
| --- | --- |
| View | Browse files and directories in approved workspaces |
| Edit | Apply changes in workspaces that allow writing |
| Execute | Run commands on a Runner |
| Jobs | Follow or cancel long-running work |
| Shared content | Use the instance's enabled MCPs and Skills |

The client, Runner and workspace settings together determine what is available. Administrators can pause shared content, rotate a client address or revoke access at any time.

## Operate safely

- Share client addresses, installation commands and Runner profiles only with their intended users.
- Rotate or revoke credentials as soon as they are exposed.
- Use a dedicated account, container or virtual machine for untrusted code.
- Review a Skill's source and content before sharing it.
- Read the [release notes](docs/release-notes.md) before upgrades and use [troubleshooting](docs/troubleshooting.md) when a task fails.

## Documentation

- [User guide](docs/user-guide.md)
- [Administrator guide](docs/admin-guide.md)
- [MCP and Skill guide](docs/central-administration.md)
- [Upgrade guide](docs/upgrading.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release status](docs/release-readiness.md)
- [Release notes](docs/release-notes.md)
- [Documentation index](docs/README.md)

Report security issues privately through [.github/SECURITY.md](.github/SECURITY.md); use Issues for ordinary problems.
