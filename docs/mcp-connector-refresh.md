# Refresh an MCP client's tools

[Documentation](README.md) · [Troubleshooting](troubleshooting.md)

Refresh the Runmesh connection when a Worker update adds a tool action or changes its accepted fields but your client still shows the older definition. The Worker, installed Runner and client's cached tool catalog are separate components. A refresh updates the client catalog; it does not upgrade the Runner or grant permissions.

## Refresh the affected connection

1. Confirm that the connection uses the administrator-supplied MCP URL for the intended instance. A display name such as `runmesh--dev` does not establish which Worker it reaches. Keep the secret URL private.
2. Open that connection's settings and use its tool-refresh or reconnect option. In ChatGPT, use **Refresh** when available in the custom MCP app or connection details. An app published to a workspace may require its administrator to update the published tool definitions.
3. Start a new conversation and select the same connection so the conversation receives the refreshed tools.
4. Check the affected action and its input fields. If they are still missing, ask the administrator to compare the server catalog with the definitions registered in your client.

Keep the same URL and credentials unless you have confirmed that the connection points to the wrong instance or its credential is invalid. Rotating a credential, reinstalling a Runner or enabling cloud history does not repair a stale tool definition.

For ChatGPT's supported setup options, see the [custom MCP connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) and [developer mode guide](https://developers.openai.com/api/docs/guides/developer-mode).

## Check Job follow-up calls

On a compatible instance, the `job` tool accepts `workspace_id` for `get`, `logs`, `cancel` and `input`. Keep it together with the `job_id` returned by `shell`. Omitting the workspace can require a cloud history lookup; a missing snapshot does not mean execution failed.

Use an approved harmless test command, save its receipt, then call the `job` tool with `action: "get"` and `action: "logs"`, passing both IDs and keeping the same Runner selected. Check that you can inspect the same Job. Only test cancellation or input on a task created for that purpose. Do not repeat an existing shell command because its history lookup failed.

If the catalog is current but the operation returns `runner_upgrade_required`, check the installed Runner's capabilities and follow the [upgrade guide](upgrading.md). A newer Worker can expose an action that an older Runner cannot execute.

## Compare catalogs when a refresh does not help

This section is for administrators with access to the intended Worker source checkout and the affected MCP client. Record the actual Worker origin and deployment commit. Use `/health` to check the deployed identity where available; a missing field is an unknown result, not proof of a match. Do not record the credential-bearing MCP path.

Export the complete authenticated `tools/list` response from an authorized MCP client, including every page. Separately export the affected client's actual registered input schemas. The second export must come from that client, not another server request. Exports use `{"tools":[{"name":"job","inputSchema":{...}}]}`; a complete JSON-RPC `tools/list` response is also accepted. Use MCP tool names without connector prefixes. Exclude connection URLs, headers, credentials, Jobs and tool results.

From a checkout matching the intended deployment, run:

```sh
npm run check:mcp-connector -- --export-source source-catalog.json
npm run check:mcp-connector -- --server-catalog server-catalog.json --host-catalog host-catalog.json
```

| Comparison | Next step |
| --- | --- |
| Source differs from the authenticated server | Check the configured instance and deployed commit before changing either one. |
| Server matches source; client inputs differ | Refresh the affected connection or have its administrator update the published definitions, then start a new conversation. |
| Server and client agree but differ from source | Check whether the checkout is newer than the deployed Worker. |
| Server or client schemas cannot be exported | Report that part as unverified; use the available live checks and seek client-specific support. |

The checker returns exit code 1 for a difference and 2 for invalid or incomplete input. It compares canonical JSON and ignores only root `$schema` annotations, so semantically equivalent but differently expressed schemas still need review. A match confirms the supplied snapshots agree; it does not prove when they were captured, that the active conversation has refreshed, or that a Job completed successfully. Finish with the live follow-up check above.
