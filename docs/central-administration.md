# Manage MCP and Skill

[简体中文](central-administration.zh-CN.md) · [Documentation](README.md)

Connect MCP services and install Skills in **MCP & Skill** at `/admin/central`. Then add your AI client to use the shared collection. See [release status](release-readiness.md) for signed packages and deployment and upgrade steps.

## Set up your collection

| Task | Steps |
| --- | --- |
| Connect an MCP | Open **MCP**, enter its public HTTPS MCP URL, choose **No authentication** or **OAuth**, and select **Connect**. For OAuth, sign in on the provider's page and complete consent. |
| Install a Skill | Open **Skill**, select its folder or `SKILL.md` and supporting text files, then select **Install Skill**. |
| Connect an AI client | Select **Connect an AI client**, enter a label, choose the access type, and create the connection. Copy the URL shown when it is created into your client's MCP settings. |

Enabled MCP tools and Skills are shared with every active AI client in this instance. MCP connections load their tools automatically; the MCP card's **View tools** button shows the available tools. Skill cards provide **View files** to read the installed content.

## Choose the AI client's access

**MCP and Skills** gives the client access to the shared collection. Runmesh handles these connections and content reads.

Choose **MCP, Skills and computer access** when the client also needs files or commands on your machines. The computer-permission choices open automatically; select the required read, write and execution permissions. Read is selected initially. Register a Runner and configure its workspaces using the [administrator guide](admin-guide.md).

See the [user guide](user-guide.md) for connecting the AI client and starting work.

## Change shared content

| Action | Result |
| --- | --- |
| MCP: **Refresh tools** | Loads the provider's current tools for all clients. If sign-in is needed, opens authorization. |
| MCP: **Pause** / **Enable** | Stops or resumes shared access. Enabling refreshes the tool list. |
| OAuth MCP: **Reconnect** | Starts a new authorization flow with the provider. |
| OAuth MCP: **Disconnect account** | Removes the account connection saved in Runmesh. Select **Reconnect** to authorize again. |
| Skill: upload an update with the same `name` in `SKILL.md` | Shows the proposed replacement; select **Update Skill** to publish it to all clients. |
| Skill: **Pause** | Stops future reads while keeping the installed files. |
| Paused Skill: **View files → Enable Skill** | Resumes access to the displayed version. |

After a change, refresh the Runmesh connection in AI clients that cache their tool or resource list. Previously delivered Skill content stays in an existing conversation; start a new conversation when you need to work exclusively with the updated content.

## Manage a client's connection

Open **AI connections** to manage each client's credential. **Rotate** creates a replacement URL and invalidates the previous one. **Revoke** stops that client's access and retains its record. **Delete** also removes the client record. Review the displayed confirmation before deleting.

Shared MCP and Skill access follows the instance's enabled collection. Computer access additionally follows the client's permissions, selected Runner and approved workspaces. Use separate instances for groups that need different shared collections.

## Continue setup or resolve a problem

- [Connect an MCP](central-remote-mcp.md): URL requirements, authentication and tool refresh.
- [Authorize an MCP account](central-oauth.md): sign-in, reconnection and account management.
- [Install and update a Skill](central-skills.md): folder layout, file sizes and updates.
- [Troubleshooting](troubleshooting.md): the next step for a failed connection or upload.

Implementation details: [administration reference](maintainers/central-administration.md).
