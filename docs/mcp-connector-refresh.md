# MCP connector contract recovery

A server deployment and a host's registered tool definitions are different
layers. A new source checkout, a green CI run, or a matching catalog hash does
not prove that a host has refreshed its inputs. Do not rotate credentials,
reinstall Runners, enable all history recording, or relax authorization to
repair a stale tool catalog.

## Identify the affected layer

Record the fixed source commit and the actual configured MCP origin. A display
name such as `runmesh--dev` does not identify the deployment environment. Do not
publish the credential-bearing endpoint path. Check that origin's `/health`;
missing catalog/provenance fields mean unobserved evidence, not a matching
current build. Do not guess a replacement endpoint from its name.

Capture the complete authenticated `tools/list` response using an existing
authorized MCP client. Collect all pages before export. Separately export the
host's actual registered input schemas. They must come from the host, not a
second server query. Both files use `{"tools":[{"name":"job","inputSchema":{...}}]}`;
a complete JSON-RPC tools/list response is also accepted. Include every tool,
use MCP names without connector prefixes, and never include connection URLs,
headers, credentials, jobs or tool results.

```sh
npm run check:mcp-connector -- --export-source source-catalog.json
npm run check:mcp-connector -- --server-catalog server-catalog.json --host-catalog host-catalog.json
```

The checker builds its source baseline from the current checkout's catalog.
It compares the complete server surface and the host's tool names/inputs.
It returns 1 for drift and 2 for invalid/incomplete evidence. Omitted layers
are `not_observed`; successful export or a matching server alone never sets
`catalog_layers_match`. It compares canonical JSON, ignoring only root `$schema`
annotations; different but semantically equivalent schemas still require
review. Metadata hashes cannot override mismatching actual schemas. Snapshot comparison
does not authenticate capture freshness or test Job execution: the report keeps
`capture_freshness=not_verified` and `live_job_verified=false`.

| Evidence | Recovery |
| --- | --- |
| Source differs from authenticated server | Verify the configured environment, fixed deployment commit and build path before deployment. |
| Server matches source; host inputs differ | Refresh that connector's metadata and verify it in a new conversation. |
| Server and host agree but differ from source | Both may describe an older deployment; do not label this host-only drift. |
| Server or host cannot be observed | Record it as unverified; do not claim end-to-end repair. |

## Refresh in ChatGPT

In the affected custom MCP app/connection details, use **Refresh** to pull
current tools and schemas, then start a new conversation and select that same
connection. Workspace-published apps can require an administrator to review
and publish an updated metadata snapshot instead. Changing server code cannot
rewrite the tool definitions already injected into an active conversation.
Keep the same connection URL and credentials unless the intended environment
itself is wrong; a rename is not an environment switch.

Official guidance: https://developers.openai.com/plugins/deploy/connect-chatgpt
and https://developers.openai.com/api/docs/guides/developer-mode

## Job acceptance

The registered `job` tool must allow optional `workspace_id` for `get`, `logs`,
`cancel` and `input`. A request without it can depend on cloud history to find
the Job's workspace; a missing snapshot is not proof that execution failed.
Do not repeat a shell command merely because its history lookup failed.

With a fresh host catalog, use a harmless test Job in a permitted workspace and
then call `job.get` / `job.logs` with both returned `job_id` and `workspace_id`.
Only test cancellation/input against the test Job, not unrelated jobs. Test
history-disabled and history-unavailable cases in the isolated test harness;
do not disable or break production storage for acceptance. Wrong workspace,
revoked credentials, insufficient scope and stale policy must still fail.

The authenticated HTTP regression in `mcp-connector-contract.test.ts` verifies
that the real Worker/SDK emits every source schema and keeps all four Job
workspace bindings. `no-record.test.ts` covers the history-independent runtime
path and its permission checks. These run in the existing Worker test CI gate;
the pure comparison regressions run in the existing release-tools gate.
