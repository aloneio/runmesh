# Security model

## Trust boundaries

1. **MCP client → Worker:** identity is a unique 256-bit random URL path secret: `/<secret>/mcp`. RegistryDO stores only its SHA-256 verifier, prefix, scopes, and metadata. Wrong, malformed, rotated, and revoked credentials all return `404`.
2. **Browser admin → Worker:** first-time PBKDF2 administrator password, opaque hashed sessions, `Secure`/`HttpOnly`/`SameSite=Strict` cookie, session expiry, logout/password-wide revocation, CSRF tokens, and same-origin checks.
3. **Worker → Durable Objects:** method/path/body HMAC using `INTERNAL_CONTROL_SECRET`.
4. **Runner → RunnerDO:** outbound TLS WebSocket with the existing enrolled token verifier, credential version, and connection epoch. This credential is independent of admin and MCP client credentials.
5. **Runner → host:** local OS identity/permissions plus workspace path policy. This is not a universal operating-system sandbox.

## Credential storage

- Administrator password: PBKDF2-HMAC-SHA-256, random salt, documented iteration count; no plaintext or direct SHA-256 password hash.
- Admin session: browser has a random raw token; Registry stores only SHA-256 hash, CSRF hash, version, and expiry.
- MCP client: raw 256-bit base64url secret appears only in the one-time create/rotate page; Registry stores only SHA-256 verifier and short prefix.
- Runner: plaintext token is returned only at enrollment/rotation; Registry stores a peppered HMAC verifier.

Changing the admin password deletes/invalidates all sessions. MCP rotation immediately replaces the verifier; revocation sets `revoked_at`. Runner rotate/revoke increments credential/connection generations and closes prior sockets.

## Browser and URL protections

Admin/MCP HTML uses `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, CSP with `frame-ancestors 'none'`, `nosniff`, and frame blocking. Admin state changes require CSRF. The Worker does not log `request.url`, the secret pathname, passwords, tokens, file content, commands, or complete output.

A secret in a URL can still be observed by browser history or infrastructure/access logs outside application code. Never publish or screenshot it; configure Cloudflare log redaction and rotate on suspected leakage.

## Workspace and execution boundary

The MCP client sends only a workspace ID and relative path. The Runner rejects absolute/UNC/device paths, NULs, traversal, symlink/junction ancestry/escapes, write-through symlinks, and readonly writes. Patch installation uses bounded baseline validation, staging, atomic per-file replacement, and protected rollback.

Shell execution is disabled by default and requires the workspace plus request to opt in. Non-shell execution uses an executable/argument vector. For untrusted repositories or commands, use an external VM/container with restricted mounts, secrets, network, and OS privileges.

## Data minimization

Workspace roots are absent from protocol metadata. MCP errors expose allowlisted stable codes and safe recovery hints, not Runner absolute paths. Files, Git output, and logs are bounded/paginated. Complete filesystem data and logs remain on the Runner.
