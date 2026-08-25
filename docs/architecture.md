# Architecture

```text
MCP client with per-client secret URL
        │ stateless MCP over HTTPS
        ▼
Cloudflare Worker
  ├─ setup/login/admin HTML
  ├─ RegistryDO (SQLite)
  └─ RunnerDO per runner_id (hibernatable WebSocket)
        │ outbound-only WSS
        ▼
Local Runner
  ├─ workspace/path policy
  ├─ filesystem and UTF-8 paging
  ├─ transactional patch and Git
  └─ persistent Job Manager
```

## Decisions

- The Worker is the only public MCP server; a Runner is never an MCP/HTTP/auth server.
- Cloudflare is a control plane. CPU, filesystem, Git, processes, and complete logs stay on the Runner.
- MCP HTTP is stateless. Each request authenticates its path secret and creates a fresh `McpServer` through `createMcpHandler`.
- MCP client authentication is single-user/self-hosted: first-time admin password plus independent `/<secret>/mcp` client URLs. There is no OAuth or KV dependency.
- Runner authentication remains the existing independent enrollment-token, verifier, credential-version, epoch, rotation, and revocation design.
- A Job belongs to the single admin instance/workspace domain, not to a chat session. `created_by_client_id` is audit metadata, not an ownership restriction.
- Runner local disk is authoritative. RegistryDO stores bounded historical metadata and never treats a bounded sync omission as immediate job deletion.

## Failure behavior

- MCP/browser closes after `exec_start`: local job continues.
- Runner WebSocket disconnects: local jobs/logs continue; live tools report `runner_offline`; `job_list` and last-known `job_get` metadata remain available from RegistryDO.
- Runner reconnects: monotonic sync upserts workspaces and recent/active job metadata.
- Runner process restarts: matching live jobs become `unknown`; reconciliation moves vanished jobs to `interrupted` without guessing the exit code. Recovered cancellation is reported as `cancelled` only with persisted delivery evidence.
- Worker/DO restart: in-flight bridge calls can fail, while Runner-local jobs continue. Callers should retry only safe/idempotent requests.

## Free Plan posture

The deployed core uses Workers and SQLite-backed Durable Objects only. WebSocket Hibernation reduces idle connection cost; local Runners carry execution/data cost. Capacity still depends on account-wide Cloudflare quotas and must be measured by the operator.
