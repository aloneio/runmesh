# Security model

This runtime is a control plane plus an execution client. Cloudflare is not a sandbox and the Worker never executes the user's command.

## Trust boundaries

1. **MCP client → Worker:** authenticated OAuth 2.1 bearer token, PKCE for public clients, least-privilege scopes, explicit owner consent. The static bearer lane exists only when `MCP_STATIC_TOKEN` is explicitly configured for local tests; it must be absent in production.
2. **Worker → Durable Objects:** internal HMAC headers over method/path/body. RegistryDO and RunnerDO internal endpoints are not public APIs.
3. **Runner WebSocket:** Runner initiates outbound TLS WebSocket and authenticates with an enrollment token in an HTTP Authorization header. Tokens are peppered HMAC verifiers in RegistryDO. Rotation/revocation increments credential versions and closes old connections.
4. **Runner → host:** local process identity and OS permissions. Workspace paths are allowlisted and canonicalized, but Node path checks do not constrain arbitrary shell effects or malicious local actors.

## Workspace boundary

The model supplies only `workspace_id` plus a relative path. The Runner maps the ID to a startup-canonicalized root. It rejects:

- absolute POSIX, drive-letter, UNC, and device paths;
- NUL bytes and `..` path components;
- unknown workspace IDs;
- symlink/junction ancestry and canonical paths outside the root;
- write-through symlinks and writes to readonly workspaces.

Patch installation uses baseline SHA-256/mode checks, same-directory exclusive temporary/backup handling, atomic per-file replacement, and rollback/recovery metadata. Cross-file atomicity is emulated by rollback; no general filesystem transaction is claimed.

## Command boundary

Shell is disabled by default and requires both a workspace `shell` capability and a request opt-in. Non-shell commands use an executable plus argument vector. Jobs run detached on POSIX and persist state/logs locally. Use a VM/container with restricted mounts, secrets, and egress for untrusted code.

## Data minimization

- Runner roots are not included in protocol workspace metadata or MCP results.
- MCP result redaction removes keys matching token/secret/password/verifier/root patterns.
- Log responses and Git diffs are bounded and cursor-paginated.
- Structured logs should include request/runner/job/method/status/duration metadata only; never auth tokens, OAuth secrets, environment secrets, or full sensitive file contents.

## Operational requirements

Set and rotate `ADMIN_TOKEN`, `RUNNER_TOKEN_PEPPER`, `INTERNAL_CONTROL_SECRET`, and `MCP_OWNER_PASSWORD` with Wrangler secrets. Keep OAuth KV private. Do not use `MCP_STATIC_TOKEN` in production. Review Cloudflare account quotas and Free Plan limits separately; local dry-run is not a production security/capacity proof.
