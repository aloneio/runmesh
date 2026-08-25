# Deployment

## Local validation

```sh
npm install
npm test
npm run typecheck
npm run build
npm run generate:schema --workspace=@remote-coding-runtime/protocol
npm run validate:worker
```

`npm run validate:worker` runs Wrangler with `--dry-run` and the repository config. It validates the bundle and bindings but does not prove a deployed account's quotas, network behavior, OAuth provider reachability, or secret configuration.

## Cloudflare resources

The Worker config uses:

- one Worker;
- SQLite-backed `RegistryDO` and `RunnerDO` classes;
- one KV namespace binding `OAUTH_KV` for the official OAuth Provider;
- no Sandbox, Containers, Dynamic Workers, queues, D1, R2, tunnel, or inbound service.

Workers Free supports SQLite-backed Durable Objects, but quotas are account-wide and exhaustion fails operations rather than transparently charging overage. Treat Free Plan as a low-volume/control-plane target and measure the actual account before making a capacity promise.

## Provisioning

1. Create a KV namespace and replace `REPLACE_WITH_OAUTH_KV_NAMESPACE_ID` in `apps/worker/wrangler.jsonc`.
2. Configure secrets:

```sh
cd apps/worker
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RUNNER_TOKEN_PEPPER
npx wrangler secret put INTERNAL_CONTROL_SECRET
npx wrangler secret put MCP_OWNER_PASSWORD
```

3. Run the safe validation command from the repository root:

```sh
npm run validate:worker
```

4. Deploy only with explicit operator authorization:

```sh
npx wrangler deploy --config apps/worker/wrangler.jsonc
```

5. Enroll a Runner via `POST /admin/runners` with `Authorization: Bearer ADMIN_TOKEN`; store the returned plaintext token securely; start the Runner with `CODING_RUNNER_TOKEN` and the single `/mcp` URL.

## OAuth

The Worker wraps only `/mcp` with `@cloudflare/workers-oauth-provider`. It publishes authorization metadata, DCR compatibility, and CIMD support. Owner authorization is an application-owned password + consent page protected by a CSRF cookie. Public clients must use S256 PKCE. `coding:read`, `coding:write`, and `coding:exec` are enforced per tool.

The local test suite covers DCR, S256, CSRF, wrong password, denied/approved consent, token exchange, two client tokens, and scope denial. It does not replace testing with a hosted ChatGPT/Claude/Cursor client against a deployed Internet URL.

## Rollback and rotation

- Rotate a Runner via `POST /admin/runners/:id/rotate`; restart the Runner with the new returned token.
- Revoke via `POST /admin/runners/:id/revoke`; the old token is invalidated and active sockets are closed.
- A Worker deploy/restart can fail an in-flight bridge request. The caller should retry only safe/idempotent operations; persistent jobs remain local and can be queried after reconnect.
