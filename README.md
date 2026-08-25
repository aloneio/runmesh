# Remote Coding Runtime

A model-neutral, client-neutral remote coding runtime:

```text
MCP client (ChatGPT / Claude / Cursor / custom agent)
        │  stateless MCP over HTTPS + OAuth 2.1
        ▼
Cloudflare Worker control plane
  /mcp  /runner/connect  RegistryDO  RunnerDO
        │  outbound authenticated WebSocket only
        ▼
Local Runner process
  secure workspace roots · filesystem · patch · git · persistent jobs
```

The Worker never calls an AI model and never executes shell commands or accesses a Runner filesystem. AI reasoning stays in the MCP client; execution stays on the local Runner.

## Status

This repository contains a tested MVP vertical slice:

- versioned language-neutral Runner↔Worker protocol and JSON Schema;
- SQLite-backed RegistryDO and one hibernatable RunnerDO per Runner;
- authenticated enrollment, rotation, revocation, reconnect, heartbeat, sync, and internal RPC forwarding;
- Node Runner with canonical workspace allowlists, symlink-aware path policy, bounded filesystem/search, atomic baseline-checked patches, bounded Git status/diff, and persistent local jobs;
- stateless `/mcp` with the current Cloudflare Agents + MCP SDK v2 stack, 2025 stateless compatibility, OAuthProvider owner-password consent flow, and a fenced static bearer lane for local tests;
- real local Worker + Runner + filesystem/process E2E tests.

MCP Tasks are deliberately deferred. `exec_start`, `job_get`, `job_logs`, `job_cancel`, and `job_input` are the stable compatibility Job API today.

## Architecture

- **Worker:** only public MCP endpoint and control-plane routing. It stores metadata, not source files or complete logs.
- **RegistryDO:** durable Runner/workspace/job metadata, token verifiers, epochs, credential versions, stale state, and sync ordering.
- **RunnerDO:** one Durable Object per Runner ID. It owns the hibernatable outbound WebSocket and correlates Worker RPC calls to the current Runner socket. It does not perform coding work.
- **Runner:** an outbound-only Node client. Jobs write local metadata and append-only stdout/stderr files, so browser/MCP/WebSocket lifetime is not the job lifetime.
- **Protocol:** `packages/protocol` is the source of truth. Future Go/Rust runners can consume `packages/protocol/schema/wire-message.schema.json`.

## Quick start (local development)

Requirements: Node.js 20+ (Node 24 is used in CI here), npm, Git, and Wrangler. Docker, Cloudflare Sandbox, Cloudflare Containers, GitHub Actions, tunnels, and inbound SSH are not required.

```sh
cd remote-coding-runtime
npm install
npm test
npm run validate:worker
```

`validate:worker` is intentionally `wrangler deploy --dry-run --config apps/worker/wrangler.jsonc`; it must not publish a deployment.

### Configure Worker secrets

Create a real KV namespace for OAuth persistence, replace the placeholder ID in `apps/worker/wrangler.jsonc`, and set secrets:

```sh
cd apps/worker
npx wrangler kv namespace create OAUTH_KV
# Put the returned id in wrangler.jsonc; do not commit it if your deployment policy forbids it.
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RUNNER_TOKEN_PEPPER
npx wrangler secret put INTERNAL_CONTROL_SECRET
npx wrangler secret put MCP_OWNER_PASSWORD
```

`MCP_STATIC_TOKEN` is test/development-only. Do not configure it in production. `OAUTH_KV` is required by the official OAuth Provider. Cloudflare Free Plan feasibility still depends on account-wide quotas and the actual namespace/secrets; local dry-run does not prove account capacity.

Deploy only when explicitly authorized:

```sh
cd apps/worker
npx wrangler deploy --config wrangler.jsonc
```

The sole hosted MCP endpoint is:

```text
https://coding.example.com/mcp
```

Configure that URL in a compatible MCP client. The Worker uses `createMcpHandler` from `agents/mcp/server` with `@modelcontextprotocol/server` v2, and wraps `/mcp` with Cloudflare's official `OAuthProvider`. Hosted clients use OAuth 2.1 authorization-code + PKCE; DCR remains available for compatibility and CIMD is enabled.

## Enroll and start a Runner

Create a Runner credential through the protected admin endpoint. The plaintext token is returned only by enrollment/rotation; the Worker stores an HMAC verifier, not the token:

```sh
curl -sS -X POST https://coding.example.com/admin/runners \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"runner_id":"home-pc"}'
```

Save the returned `token` in a secret manager or environment variable. Start the Runner from the machine that owns the code:

```sh
CODING_RUNNER_TOKEN='returned-token' \
  npx tsx apps/runner/src/cli.ts start \
  --server wss://coding.example.com \
  --runner-id home-pc \
  --workspace zero=/home/me/code/zero\;writable\;noshell
```

For local Wrangler development only:

```sh
CODING_RUNNER_TOKEN='returned-token' \
  npx tsx apps/runner/src/cli.ts start \
  --server ws://127.0.0.1:8787 --insecure-local \
  --runner-id home-pc \
  --state-dir /tmp/remote-coding-runner-home-pc \
  --workspace zero=/home/me/code/zero\;writable\;noshell
```

The Runner only makes outbound `ws://`/`wss://` connections. Production requires `wss://`; cleartext `ws://` is accepted only for loopback with `--insecure-local`.

Workspace syntax defaults to `readonly;noshell`:

```text
--workspace id=path[;readonly|writable][;shell|noshell]
```

The MCP client can address only `runner_id` and `workspace_id`; it cannot supply an arbitrary host root.

## Tool catalog

The MVP exposes exactly these tools:

- Runtime: `runner_list`, `runner_info`, `workspace_list`, `env_info`
- Filesystem: `fs_read`, `fs_list`, `fs_search`, `fs_apply_patch`
- Execution/jobs: `exec_start`, `exec_run`, `job_get`, `job_logs`, `job_cancel`, `job_input`
- Git: `git_status`, `git_diff`

Writes and execution require OAuth scopes (`coding:write`, `coding:exec`). `fs_apply_patch` is baseline-checked and transactional with rollback; `git_diff` and logs are bounded for model context windows.

## Persistent jobs

`exec_start` returns quickly with a `job_id`. The Runner persists:

```text
~/.remote-coding-runner/state/
├── runner.json
└── jobs/<job_id>/{meta.json,stdout.log,stderr.log}
```

The child process is detached from the Runner transport on POSIX. Closing a browser or MCP request does not stop it. A later MCP client can call `job_get` and `job_logs`. A Runner WebSocket disconnect does not stop it; local disk is authoritative and reconnect sync repairs Worker metadata.

On Runner restart, an in-flight job is conservatively marked `unknown` if a matching live process can be observed, or `interrupted` if it is gone/fingerprint-mismatched. The MVP does not claim reattachment to an existing child process.

Logs are paginated by UTF-8-safe byte cursor. Responses are bounded; local log files are intentionally complete and unbounded by default, so operators must monitor disk usage.

## Security model

- OAuthProvider owns OAuth 2.1 token issuance, PKCE, DCR, token hashing, and KV persistence. The application-owned `/authorize` page requires the owner password, CSRF cookie, and explicit consent.
- Runner enrollment/admin routes require `ADMIN_TOKEN`; Runner WebSocket auth requires the enrolled token over the `Authorization` header. Tokens are never sent in query strings or printed in logs.
- RegistryDO calls require an internal HMAC header. Stored Runner credentials are peppered HMAC verifiers. Rotate/revoke increments credential versions and closes old sockets.
- Every local path is resolved from an allowlisted workspace ID. Absolute paths, NULs, `..`, symlink/junction escapes, and write-through symlinks are rejected. This is a path authorization boundary, not a hostile OS sandbox: run untrusted code in an external VM/container with restricted secrets/network.
- Shell is opt-in per workspace and per request. Non-shell commands use an argument vector. Process and Git outputs are bounded before MCP framing.
- MCP result text and structured output redact keys that look like tokens, secrets, passwords, verifiers, or roots. Host paths are not part of the wire workspace metadata.

## Protocol and compatibility

`packages/protocol` defines protocol version, correlation IDs, hello/welcome negotiation, heartbeat, sync, RPC, and job lifecycle messages. Same-major extensions belong in explicit `extensions`; unknown top-level fields are rejected by design until negotiated compatibility is expanded. The checked-in JSON Schema is generated and exported for non-TypeScript implementations.

The server uses stateless MCP Streamable HTTP with the current Cloudflare Agents/MCP SDK stack and retains the legacy 2025 stateless lane. It does not use the deprecated `McpAgent` for the new server.

## Tests and evidence

```sh
npm test
npm run typecheck
npm run build
npm run validate:worker
```

The tests include protocol/unit tests, real Node subprocess jobs, symlink/traversal/patch/Git security tests, Worker Durable Object tests, local OAuth PKCE/CSRF/scope tests, hibernation-helper behavior coverage, and a hermetic E2E that starts a local Wrangler Worker and real Runner CLI. The E2E covers live `fs_read`, persistent `exec_start`, MCP stateless follow-up, transport-only Runner disconnect/reconnect with a long job, readonly patch rejection, traversal, UTF-8 stdout/stderr pagination, bounded output, and concurrent reads.

### Evidence boundaries

- **Automated locally:** all behavior named above, plus Wrangler bundle/dry-run and protocol/package checks.
- **Not proven by local tests:** a deployed Cloudflare account's Free Plan quotas, real Cloudflare Internet OAuth/CIMD fetches, production secret rotation, Worker deployment/restart behavior, and a live production DO hibernation cycle. These require an authorized deployment/account and must not be inferred from `validate:worker`.
- **Deferred:** MCP Tasks extension integration, browser mid-request abort semantics beyond prompt `exec_start` return, 33rd bridge saturation test, and full Runner crash/restart process E2E.

## Acknowledgements and licensing

This project is an independent implementation. It does not copy source code from the references. The design study used:

- [`xyTom/coding-tools-mcp`](https://github.com/xyTom/coding-tools-mcp), Apache-2.0 + NOTICE: path confinement, patch staging/rollback, bounded output, process lifecycle, and permission concepts.
- [`volter-ai/volter-tunnel`](https://github.com/volter-ai/volter-tunnel), Apache-2.0 + NOTICE: typed outbound WebSocket relay, one Durable Object per connection ID, reconnection, and hibernation concepts.
- [`Hiroshimeow/agent-mcp-gateway`](https://github.com/Hiroshimeow/agent-mcp-gateway), MIT: workspace registry and structured gateway concepts.
- The requested `davidlosasgonzalez/codeagent-mcp` URL was checked and currently returns 404; no code or license was used.
- Cloudflare Agents, MCP TypeScript SDK, Workers OAuth Provider, Durable Objects, and WebSocket Hibernation official documentation were consulted for current APIs.

No OpenAI, Anthropic, Gemini, other model API, OpenCode, Claude Code API, Cloudflare Sandbox, Cloudflare Containers, Dynamic Workers, GitHub Actions runtime, tunnel, or inbound SSH is used.
