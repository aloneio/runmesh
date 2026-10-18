# Manage MCP and Skill

[简体中文](central-administration.zh-CN.md) · [Documentation](README.md)

Use **MCP & Skill** in the control panel to connect MCP services, install Skills and share them with your AI clients.

## Three steps to start

1. **Connect an MCP.** Open **MCP**, enter the address provided by the service, choose **No authentication** or OAuth, and finish the connection or sign-in.
2. **Install a Skill.** Select the folder containing `SKILL.md`, or select `SKILL.md` and its supporting text files, then choose **Install Skill**.
3. **Connect an AI client.** Choose **Connect an AI client**, enter a label, select the access scope and create the connection. Copy the address shown by Runmesh into the client's MCP settings.

Enabled MCP tools and Skills are shared with active AI clients in the instance. Refresh the Runmesh connection in a client when it still shows an earlier list after an install or update.

## Choose the access scope

- **MCP and Skills:** access to the instance's shared MCPs and Skills.
- **MCP, Skills and computer access:** the shared collection plus files and commands in approved Runner workspaces.

Choose computer permissions when creating the connection. Add a machine on **Runner** first, then approve the workspaces it may use. The [administrator guide](admin-guide.md) covers machine and workspace setup.

## Everyday management

| Action | Result |
| --- | --- |
| MCP **Refresh tools** | Reads the provider's latest tools and updates the shared list. |
| MCP **Pause** / **Enable** | Pauses or resumes sharing. Enabling reads the tools again. |
| OAuth **Reconnect** | Opens the provider sign-in page again. |
| OAuth **Disconnect account** | Removes the saved account connection; reconnect when needed. |
| Upload a Skill update | Review the changes, then confirm **Update Skill**; the update applies to every client. |
| Skill **Pause** / **Enable** | Pauses or resumes reads while keeping the installed content. |

You can change a Skill's friendly name in the Central list. The name remains after a refresh. A deleted Skill does not return automatically, and its original Skill ID cannot be reused for new content.

## Manage AI client connections

On **AI connections**:

- **Rotate** creates a new address and immediately invalidates the old one.
- **Revoke** stops access while keeping the connection record.
- **Delete** removes the connection record.

The address and Runner enrollment command are credentials. Share them only through a secure channel. Rotate or revoke them immediately if they are exposed.

Continue with the [user guide](user-guide.md), [MCP account authorization](central-oauth.md), [Skill installation and updates](central-skills.md) or [troubleshooting](troubleshooting.md). See [release status](release-readiness.md) for deployment and version information.
