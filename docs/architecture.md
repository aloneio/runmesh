# Architecture

## Components

```text
Hosted/local MCP clients
        │ HTTPS / stateless Streamable HTTP / OAuth
        ▼
Cloudflare Worker
  ├─ createMcpHandler (/mcp)
  ├─ OAuthProvider and owner consent
  ├─ RegistryDO (SQLite metadata)
  └─ RunnerDO per runner_id (hibernatable outbound WebSocket)
        │
        │ outbound-only WSS initiated by Runner
        ▼
Runner
  ├─ workspace registry + path policy
  ├─ bounded filesystem/search
  ├─ atomic patch engine
  ├─ Git inspection
  └─ persistent Job Manager + local logs
```

## Design decisions

- The Worker is the only Remote MCP server. A Runner is not an MCP or OAuth server.
- MCP request state is stateless. Durable application state is explicit in RegistryDO/RunnerDO and local Runner storage.
- A Runner owns the job lifecycle. An MCP request starts or queries a job; it does not parent the process.
- Worker/DO storage contains metadata and small bounded results, never the filesystem or complete terminal logs.
- Multiple MCP clients share the same authenticated user/workspace/job domain; a chat window is not the job owner.
- Long-running AI reasoning does not continue after the MCP client closes. Only execution jobs continue; no second AI agent or model API is embedded.

## Failure behavior

- MCP/browser disconnect: a started local job continues.
- Runner WebSocket disconnect: local jobs/logs continue; Worker live tools return `runner_offline`; automatic reconnect and monotonic sync repair metadata.
- Runner process restart: detached jobs may remain alive, but the MVP cannot reattach streams/stdin; status is conservatively `unknown` or `interrupted`.
- Worker/DO restart: Runner reconnects. In-flight bridge HTTP calls can fail and must be retried according to idempotency; persistent job state is not lost.
- Runner offline: full logs/files are unavailable; bounded registry metadata can still be returned where supported.

## Scale and Free Plan posture

One DO per Runner isolates connection state and makes routing deterministic. Registry metadata is deliberately small. WebSocket Hibernation allows connected Runner sockets while the DO is idle. CPU/filesystem work remains on the Runner, so Cloudflare is a control plane rather than a compute/data bottleneck.
