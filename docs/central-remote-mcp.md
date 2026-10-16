# Connect an MCP

[简体中文](central-remote-mcp.zh-CN.md) · [MCP and Skill guide](central-administration.md)

Add an MCP once in the control panel, then use its enabled tools from your connected AI clients.

## Add the connection

1. Open **MCP & Skill → MCP**.
2. Paste the provider's public HTTPS MCP endpoint into **MCP URL**, for example `https://mcp.example.com/mcp`.
3. Choose **No authentication** for a public MCP, or **OAuth** for an account connection.
4. Optionally enter a name, then select **Connect**. An omitted name is filled from the hostname.
5. For OAuth, complete sign-in and consent on the provider's page. Runmesh returns to the panel and loads the tools.

Use the direct endpoint on the standard HTTPS port. The URL should contain its hostname and MCP path; keep account credentials in the OAuth flow. If the provider gives you a download or setup page, obtain its MCP endpoint from its connection instructions.

OAuth providers can use a client metadata document or automatic client registration. Providers that require a pre-registered OAuth application can use the optional **OAuth client settings** in the connection form. See [MCP account authorization](central-oauth.md) for the sign-in flow.

## Check a connection

Connection checks, `server.json` import and `remote_search` are available in compatible control planes running 0.1.8 or later. Use [release status](release-readiness.md) to choose your deployment channel.

Enter the MCP URL and select **Check connection** to see its negotiated protocol, tool count and declared capabilities. You can also check an enabled MCP from its card. If sign-in is needed, choose **OAuth → Connect** for a new connection, or **Reconnect** on its card.

The check reads connection information. Select **Connect** to add the MCP, or **Refresh tools** to update an existing MCP's shared tool list.

Runmesh treats an upstream HTTP `401` as an authentication challenge and may ask you to reconnect. An upstream HTTP `403` means the provider accepted the credential but denied MCP access; Runmesh reports a provider permission error instead of starting another OAuth loop. Check the provider's MCP feature availability and the account, group or project permissions in that case.

## Import a server.json entry

Expand **Import server.json**, choose the provider's file, then select **Preview connections**. For a ready HTTPS entry, select **Use this connection** to fill the connection form, choose the authentication method and select **Connect**.

Entries that need additional configuration show a prompt to check the provider's connection instructions. Package entries show the package details; after hosting one, add its HTTPS endpoint through the same connection form.

## Use and refresh tools

Select **View tools** on the MCP card to see tool names and descriptions. Enabled tools are shared with the instance's active AI clients. To connect a client, follow the [user guide](user-guide.md).

When the provider changes its tools, select **Refresh tools**. RunMesh automatically publishes the complete compatible tool set, including new or changed definitions, without a separate approval step. Existing pending or partially approved catalogs are brought up to date by the same refresh. An identical, fully published catalog does not create a new version. If refresh fails, the saved catalog is retained.

Runmesh exposes direct tools for smaller collections and directory tools for browsing larger collections. An AI client can use `remote_profiles` to find MCPs, `remote_search` to search by keywords, `remote_tools` to read complete tool definitions, and `remote_call` to invoke a tool with its returned ID and version. Search matches tool names, titles, descriptions and connection names; add `profile_id` to search one MCP. Refresh the client's catalog after adding or changing a connection.

## Pause or resume

**Pause** stops tool access for every client and keeps the saved connection. **Enable** resumes sharing and reloads tools. For OAuth MCPs, the account connection is retained through pause/resume; **Disconnect account** removes the account connection saved in Runmesh. Details are in the [authorization guide](central-oauth.md).

## Connection format and size

Runmesh connects to public HTTPS MCP endpoints using Streamable HTTP, including JSON and request-scoped SSE responses. It forwards returned text, images, audio, resources and structured results to the client. Each call uses its own upstream session.

| Item | Limit |
| --- | --- |
| Complete tool catalog | 512 tools |
| Outbound request | 64 KiB |
| One upstream response | 2 MiB |
| Combined upstream responses in one operation | 8 MiB |
| Returned content items | 128 |
| Operation time | 20 seconds |

For large outputs, use the provider's paginated or filtered tools. If a call times out after dispatch, check the result in the provider before repeating an action that changes data.

For errors, see [troubleshooting](troubleshooting.md). Protocol and deployment details are in the [transport reference](maintainers/central-remote-mcp.md).

## Partial tool compatibility

Both initial discovery and later refreshes automatically publish supported tools while listing exclusions for unsupported
schemas or required interactive features. The exclusion warning is not an OAuth failure. If all tools are unsupported, the existing catalog is preserved. See
[the compatibility matrix](mcp-compatibility.md) before changing credentials.
