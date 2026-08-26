# Security model

## Trust boundaries

1. **MCP client → Worker:** a unique 256-bit random URL path credential: `/<secret>/mcp`. RegistryDO stores only its SHA-256 verifier, prefix, scopes, metadata, and sticky active-runner selection. Wrong, malformed, rotated, and revoked credentials all return `404`.
2. **Browser admin → Worker:** first-time PBKDF2 administrator password, opaque hashed sessions, `Secure`/`HttpOnly`/`SameSite=Strict` cookies, session expiry, logout/password-wide revocation, CSRF tokens, same-origin checks, and a pre-authentication throttle.
3. **Worker → Durable Objects:** method/path/body HMAC using `INTERNAL_CONTROL_SECRET`.
4. **Runner enrollment → Worker:** a 43-character enrollment code sent only to `POST /runner/enroll`; RegistryDO stores its SHA-256 verifier, expiry, and use state. Successful redemption replaces it with a peppered long-lived Runner-token verifier.
5. **Runner → RunnerDO:** outbound TLS WebSocket with the enrolled credential, credential version, and connection epoch. This credential is independent of admin and MCP-client credentials.
6. **Runner → host:** local OS identity/permissions plus workspace path policy. This is not a universal operating-system sandbox.

## Credentials, lifetime, and revocation

- **Administrator password:** PBKDF2-HMAC-SHA-256 with random salt and a versioned verifier; no plaintext or direct SHA-256 password hash.
- **Admin session:** the browser holds a random raw session token and CSRF value; RegistryDO stores only hashes, session version, and expiry. Changing the password invalidates all sessions.
- **MCP client:** a 256-bit base64url secret appears only in the one-time create/rotate page; RegistryDO stores only its SHA-256 verifier and short prefix. A per-client active Runner ID is routing state, not a credential.
- **Runner enrollment:** a code is single-use and expires after 30 minutes. Creating a new code for a Runner removes any still-unused prior code. It is not written into the Runner profile.
- **Runner token:** the enrollment response returns the plaintext token once; the profile stores it locally, and RegistryDO stores a peppered HMAC verifier.

MCP-client rotation immediately replaces the verifier; revocation marks the client revoked so its URL returns uniform `404`. Runner rotation/revocation increments credential/connection generations and closes the prior Runner socket. A revoked Runner cannot reconnect with its prior credential. Revocation clears synchronized Runner workspace/job metadata in RegistryDO, but does not kill a process that is already running on the local machine; host access and process containment remain operator responsibilities.

## Browser protections and throttle

Admin/MCP HTML uses `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff`, and frame blocking. Admin state changes require CSRF and same-origin checks. Setup and login each use a RegistryDO-backed global pre-authentication throttle: the first five failed KDF attempts are allowed, then a 30-second block begins; subsequent failures back off exponentially up to 15 minutes. A successful operation resets that kind's throttle state.

This throttle is deployment-wide by setup/login kind. It is neither per-IP nor per-user and is not a complete distributed abuse-control system. It exists to serialize/limit repeated expensive KDF attempts. It should be supplemented by edge controls appropriate to the deployment.

The Worker does not log raw request URLs, secret pathnames, passwords, tokens, file contents, commands, or complete output. A URL credential may still appear in browser history or infrastructure/access logs outside application code. Never publish, screenshot, or log a secret URL; configure Cloudflare log redaction and rotate on suspected exposure.

The current HTML CSP is deliberately restrictive in most respects but permits inline styles and scripts:

```text
default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';
form-action 'self'; base-uri 'none'; frame-ancestors 'none'
```

The inline dashboard CSS/JavaScript requires the `unsafe-inline` allowances. Escaping is used for dynamic fields, but the policy is weaker than a nonce/hash/external-resource policy. Dashboard changes must be treated as XSS-sensitive; eliminating inline content or adding nonces/hashes is deferred hardening work.

## Sticky Runner routing and shared context

Every MCP client has a persistent active Runner selection. `runner_list` returns safe Runner metadata; `runner_current` returns the client's selection; `runner_select` creates the first selection directly and requires `confirm_switch: true` to change to another Runner. The selection survives client label changes and MCP-secret rotation.

Ordinary workspace/filesystem/execution/Git/job tools do not accept `runner_id`; the Worker resolves the selected Runner. `workspace_id` remains in tools that need a workspace. This prevents per-request accidental cross-host routing but does not create separate tenants: MCP clients with matching scopes and the same selected Runner share configured workspace IDs and bounded job history. Job creator information is audit metadata only.

There is no silent fallback after an active Runner becomes offline, stale, revoked, deleted, or otherwise unavailable. Tools expose a selected-Runner error/context. An operator or MCP client must inspect `runner_current` and explicitly select a different Runner. Deleting a Runner clears selections that reference it. An unselected client can be automatically persisted only when exactly one registered Runner exists.

## Local profile and service-manifest boundary

The local Runner profile contains the long-lived Runner token and workspace paths, so it must be treated as credential material. On POSIX it is created under a `0700` directory with mode `0600`; Windows ACLs are not inspected by the implemented `doctor` command. `status` redacts the token, but workspace paths are local administrative data and should not be treated as safe to expose.

The service adapter writes only marked, content-hashed manifests and refuses to overwrite/remove an unmarked or changed file. New system profiles use the `dedicated_user` identity: Linux renders `User=runmesh` and `Group=runmesh`, macOS LaunchDaemon renders `UserName=runmesh`, and Windows uses `NT AUTHORITY\LOCAL SERVICE` at least privilege. Operators provision that account/group and its profile/state/workspace access. `privileged_host` is an explicit root/SYSTEM mode and requires `--confirm-privileged-host`; profiles created before execution modes preserve their legacy privileged layout when explicitly confirmed rather than silently changing an existing installation. `doctor --json` marks profile permission and installed/active service failures required, marks missing Python/Docker optional warnings, and does not inspect Windows ACLs. Public bootstrap endpoints are secret-free and require an operator-configured stable package spec; no package is published by this repository.

## Workspace and execution boundary

The MCP client sends a selected Runner plus workspace ID and relative path; host workspace roots never cross the protocol. The Runner rejects absolute/UNC/device paths, NULs, traversal, symlink/junction ancestry/escapes, write-through symlinks, and readonly writes. Patch installation uses bounded baseline validation, staging, atomic per-file replacement, and protected rollback.

Shell execution is disabled by default for legacy workspace syntax and requires both workspace policy and request opt-in. Non-shell execution uses an executable/argument vector. For untrusted repositories or commands, use an external VM/container with restricted mounts, secrets, network, and OS privileges.

## Data minimization

Workspace roots are absent from protocol metadata. MCP errors expose allowlisted stable codes and recovery hints, not Runner absolute paths. Files, Git output, and logs are bounded/paginated. Complete filesystem data and logs remain on the Runner. RegistryDO stores bounded job metadata to support offline listing, not a complete copy of Runner state.
