# Refresh an MCP client's tools

[Documentation](README.md) · [Troubleshooting](troubleshooting.md)

Refresh the Runmesh connection when a Worker update adds an action or changes fields while your client still shows an older definition. Update the Worker, installed Runner and client catalog as separate parts of an [upgrade](upgrading.md).

## Distinguish connection failures from Runner state

The MCP route returns the same HTTP 404 for missing, malformed, unknown, rotated or revoked credentials. Its rejection body is a JSON-RPC error with `id: null`; it does not identify the rejected client or explain which credential check failed. The pre-SDK body-limit, relay-recursion and missing-configuration guards also return JSON error bodies while retaining HTTP 413, 508 and 503 respectively. Clients must inspect the HTTP status as well as the body. A JSON response does not make a rejected credential valid.

An authenticated `runner_current` or `runner_list` call can succeed while reporting an offline or stale Runner. A client's **Credential active** status only means its stored credential has not been revoked; it does not prove that the URL configured in a caller still matches that credential or that a Runner is connected. Confirm the intended instance and client before rotating a credential. Rotation preserves that client's identity, permissions and selected Runner, but callers using the previous URL must update their connection. Record status, content type, time and deployment identity when diagnosing a rejection, without saving the secret-bearing path.

## Refresh the affected connection

1. Confirm that the connection uses the administrator-supplied MCP URL for the intended instance. Check the configured origin, as a display name such as `runmesh--dev` can be chosen freely. Keep the secret URL private.
2. Open that connection's settings and use its tool-refresh or reconnect option. In ChatGPT, use **Refresh** when available in the custom MCP app or connection details. An app published to a workspace may require its administrator to update the published tool definitions.
3. Start a new conversation and select the same connection so the conversation receives the refreshed tools.
4. Check the affected action and its input fields. If they are still missing, ask the administrator to compare the server catalog with the definitions registered in your client.

Keep the same URL and credentials while refreshing metadata. Correct the configured instance or credential only if those checks identify a separate problem.

For ChatGPT's supported setup options, see the [custom MCP connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) and [developer mode guide](https://developers.openai.com/api/docs/guides/developer-mode).

## Check Job follow-up calls

On a compatible instance, the `job` tool accepts `workspace_id` for `get`, `logs`, `cancel` and `input`. Keep it together with the `job_id` returned by `shell`. Supplying the workspace lets follow-up calls use the Job's local state even when its cloud snapshot is missing.

Use an approved harmless test command, save its receipt, then call the `job` tool with `action: "get"` and `action: "logs"`, passing both IDs and keeping the same Runner selected. Check that you can inspect the same Job. Use a task created for the test when checking cancellation or input. Recover an existing Job through its original receipt before considering another launch.

If the catalog is current but the operation returns `runner_upgrade_required`, check the installed Runner's capabilities and follow the [upgrade guide](upgrading.md). The installed Runner must support the action advertised by the Worker.

## Compare catalogs when a refresh does not help

This section is for administrators with access to the intended Worker source checkout and the affected MCP client. Record the actual Worker origin and deployment commit. Use `/health` to check the deployed identity where available and record missing fields as unknown. Keep the credential-bearing MCP path out of the report.

Export the complete authenticated `tools/list` response from an authorized MCP client, including every page. Separately export the affected client's actual registered input schemas. Obtain the second export from that client's registered definitions. Exports use `{"tools":[{"name":"job","inputSchema":{...}}]}`; a complete JSON-RPC `tools/list` response is also accepted. Use MCP tool names without connector prefixes. Exclude connection URLs, headers, credentials, Jobs and tool results.

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

The checker returns exit code 1 for a difference and 2 for invalid or incomplete input. It compares canonical JSON, ignoring root `$schema` annotations; review differences even when two schemas appear equivalent. After the exports match, start a fresh conversation and complete the live Job follow-up check above.
