# Authorize an MCP account

[简体中文](central-oauth.zh-CN.md) · [MCP and Skill guide](central-administration.md)

Choose **OAuth** when an MCP uses an account at its provider. Runmesh opens the provider's sign-in and consent pages, then returns you to the control panel. This guide covers Runmesh 0.1.6.

## Connect

1. Open **MCP & Skill → MCP**, enter the public HTTPS MCP URL, and choose **OAuth**.
2. Select **Connect**. Runmesh saves the connection and opens the provider's authorization page.
3. Sign in to the intended account, review the requested access, and complete consent.
4. Wait for the Runmesh callback to finish. The panel then loads the MCP's tools and shows the connection.

The account connection is shared by the instance's active AI clients. Review which account and provider permissions you select with that shared use in mind.

Runmesh discovers the provider settings from the MCP endpoint. The provider needs OAuth metadata and either client metadata document support or dynamic client registration. Use the endpoint listed in the provider's MCP instructions.

## Reauthorize

Select **Reconnect** on an enabled MCP card to start a fresh authorization flow. It opens the provider even if you authorized this MCP previously. An existing provider session may take you directly to consent or back to Runmesh.

When you explicitly refresh tools and the connection needs sign-in, Runmesh opens authorization automatically. On returning from OAuth, tool discovery continues in the panel.

If you leave the flow before finishing, return to **MCP & Skill** and select **Reconnect** on the saved card. For a paused MCP, select **Enable** first.

## Pause sharing or disconnect an account

- **Pause** stops access to the MCP's tools and keeps the account connection for later use.
- **Disconnect account** removes the account connection from Runmesh. Use **Reconnect** to authorize again.
- To remove the authorization at the provider too, open the provider's connected-app or authorized-app settings and revoke Runmesh there.

These actions control future access. Check the provider for the result of any action already submitted before disconnecting.

## Resolve a sign-in problem

| What you see | Next step |
| --- | --- |
| The sign-in page has not opened | Read the Runmesh message, check the MCP URL, and use **Reconnect** on the enabled card. |
| Consent was cancelled or expired | Return to the panel and select **Reconnect** to start a fresh attempt. |
| Authorization returned, but tools have not loaded | Select **Refresh tools**; complete sign-in if prompted. |
| The provider shows an error | Record its error message and the time. Check the provider's session and status before starting a new authorization attempt. |
| `oauth_configuration_required` | Ask the instance administrator to restore the existing deployment secret and then reconnect. |

## Administrator notes

OAuth credentials are encrypted through the shared secret-storage module using the existing `INTERNAL_CONTROL_SECRET`. Preserve that value during upgrades. Changing it requires connected MCP accounts to authorize again.

Keep callback URLs, authorization codes and tokens out of shared logs and support attachments. For deployment setup, see [runtime configuration](runtime-config.md); for implementation details, see the [OAuth reference](maintainers/central-oauth.md).
