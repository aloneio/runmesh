# Deployment

## Local validation

```sh
npm install
npm test
npm run typecheck
npm run build
npm run validate:worker
```

`validate:worker` invokes Wrangler with `--dry-run` and the Worker config. It validates the bundle and Durable Object bindings but does not publish a deployment or prove production account quotas, network behavior, or edge log policy.

## Cloudflare resources

The Worker uses only:

- one Worker;
- SQLite-backed `RegistryDO` and `RunnerDO` classes;
- no KV, D1, R2, Queues, Sandbox, Containers, Dynamic Workers, tunnels, or inbound service.

## Secrets

Configure only the Runner/control-plane secrets:

```sh
cd apps/worker
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RUNNER_TOKEN_PEPPER
npx wrangler secret put INTERNAL_CONTROL_SECRET
```

The first administrator password is created through the HTTPS setup page and is stored only as a PBKDF2-HMAC-SHA-256 verifier in RegistryDO. No bootstrap password environment variable is required by design; first setup is first-success-wins and should be performed immediately after deployment.

## Deploy and setup

```sh
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

Then open the deployed root URL, complete `/setup`, log in, and create one independent MCP client URL per ChatGPT/Claude/Cursor/custom client. Configure the generated URL directly in that MCP client:

```text
https://mcp.aloneio.com/<secret>/mcp
```

The full URL is a bearer credential and is displayed only at client creation/rotation. Store it securely and rotate it if exposed.

## Runner enrollment

Runner administration intentionally remains a separate `ADMIN_TOKEN` API:

```sh
curl -sS -X POST https://mcp.aloneio.com/admin/runners \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"runner_id":"home-pc"}'
```

Start the Runner with the returned token in `CODING_RUNNER_TOKEN` and an outbound `wss://` server. Only loopback `ws://` with explicit `--insecure-local` is permitted for development.

## Operational limits

The shared timeout contract is an 8-second maximum local operation and a 12-second Worker bridge timeout. Use `exec_start` for long work. Registry retains active jobs and up to 1,000 terminal jobs per Runner; complete local logs remain on the Runner and are unbounded by default.

MCP URL path secrets can be present in infrastructure access logs even though application code does not log them. Configure appropriate edge redaction and use rotation/revocation as the recovery mechanism.
