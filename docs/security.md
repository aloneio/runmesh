# Security model

Runmesh is designed to keep execution on machines you control while limiting what each MCP client can do. For an operator-friendly explanation, read the [administrator guide](admin-guide.md) and [user guide](user-guide.md) first. This page records the detailed boundaries for security review and production acceptance.

## Trust boundaries

1. **MCP client → Worker:** a unique 256-bit random URL path credential: `/<secret>/mcp`. RegistryDO stores only its SHA-256 verifier, prefix, scopes, metadata, and sticky active-runner selection. Wrong, malformed, rotated, and revoked credentials all return `404`.
2. **Browser admin → Worker:** atomic first-success-wins setup without an additional bootstrap token, PBKDF2 administrator password, opaque hashed sessions, `Secure`/`HttpOnly`/`SameSite=Strict` cookies, session expiry, atomic password-generation binding, CSRF tokens, same-origin checks, and source-specific plus global pre-authentication budgets.
3. **Worker → Durable Objects:** method/path/body HMAC using `INTERNAL_CONTROL_SECRET`.
4. **Runner enrollment → Worker:** a 43-character enrollment code sent only to `POST /runner/enroll`; RegistryDO stores its SHA-256 verifier, expiry, and use state. Successful redemption replaces it with a peppered long-lived Runner-token verifier.
5. **Runner → RunnerDO:** outbound TLS WebSocket with the enrolled credential, credential version, and connection epoch. This credential is independent of admin and MCP-client credentials.
6. **Runner → host:** local OS identity/permissions plus workspace path policy. This is not a universal operating-system sandbox.

## Credentials, lifetime, and revocation

- **Administrator password:** PBKDF2-HMAC-SHA-256 with random salt and a versioned verifier; no plaintext or direct SHA-256 password hash.
- **First setup:** no additional bootstrap token is required. Password confirmation, CSRF, same-origin checks and atomic first-success-wins remain. An uninitialized public instance can be claimed by its first successful visitor; complete setup before untrusted exposure. Initialized instances reject further setup.
- **Admin session:** the browser holds a random raw session token and CSRF value; RegistryDO stores only hashes, session version, and expiry. Changing the password invalidates all sessions. Session creation compares the generation used for password verification with the current generation inside the insertion transaction, so an in-flight old-password login cannot mint a valid post-rotation session.
- **MCP client:** a 256-bit base64url secret appears only in the one-time create/rotate page; RegistryDO stores only its SHA-256 verifier and short prefix. A per-client active Runner ID is routing state, not a credential.
- **Runner enrollment:** a code is single-use and expires after 30 minutes. Creating a new code for a Runner removes any still-unused prior code. It is not written into the Runner profile.
- **Runner token:** the enrollment response returns the plaintext token once; the profile stores it locally, and RegistryDO stores a peppered HMAC verifier.

Credential rotation/revocation increments credential/connection generations and closes the prior Runner socket. A revoked Runner cannot reconnect with its prior credential. Revoke retains central Runner, managed Workspace, immutable Policy, and retained Job metadata for operator review; Delete is the permanent cleanup operation and clears the Runner's policy versions, jobs, workspaces, overrides, and client selections. Neither operation kills a process already running on the local machine.

## Browser protections and throttle

Admin/MCP HTML uses `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff`, and frame blocking. Admin state changes require CSRF and same-origin checks. Setup and login reserve KDF attempts atomically per source: the first five attempts are allowed, then a 30-second block begins; repeated failures back off exponentially up to 15 minutes. A successful operation clears only its own source bucket, not other sources or the shared CPU budget. Each setup/login kind also has a fixed 120-attempt, 60-second global KDF budget. Blocked-source checks are read-only. Cleanup is sampled and capacity pressure evicts the oldest unblocked source first. Source state is stored in the additive `auth_source_throttle` table, with at most 2,048 keys including reserved global slots, and one-hour retention.

Only the Cloudflare edge-populated `CF-Connecting-IP` is used to derive a domain-separated HMAC source key; raw IP addresses are not persisted and `X-Forwarded-For` is not trusted. Missing or malformed source metadata shares an unattributed bucket. A custom proxy must preserve the trusted edge boundary rather than accept caller-supplied address headers. Provider write failures use a bounded in-memory fallback and surface the existing protection warning; fallback reservations do not survive eviction/restart. Global budget or key-capacity exhaustion intentionally fails closed and can still affect all users under distributed abuse. Access, WAF/rate limits, and MFA remain deployment responsibilities, not guarantees provided by this limiter.

The Worker does not log raw request URLs, secret pathnames, passwords, tokens, file contents, commands, or complete output. A URL credential may still appear in browser history or infrastructure/access logs outside application code. Never publish, screenshot, or log a secret URL; configure Cloudflare log redaction and rotate on suspected exposure.

Rendered administrator pages authorize only the exact application-owned script using a fresh response nonce. Other response headers default to disallowing scripts. Inline styles remain permitted:

```text
default-src 'none'; connect-src 'self'; img-src 'self' data:;
style-src 'unsafe-inline'; script-src 'nonce-<fresh-random-value>';
form-action 'self'; base-uri 'none'; frame-ancestors 'none'
```

A generic injected script tag is not assigned a nonce. Escaping remains mandatory in every HTML/attribute/script context; a nonce is defense in depth, not an XSS-proofing substitute. Moving inline styles to static assets and browser-level CSP acceptance testing remain hardening tasks.

## Sticky Runner routing and shared context

Every MCP client has a persistent active Runner selection. `runner_list` returns safe Runner metadata; `runner_current` returns the client's selection; `runner_select` creates the first selection directly and requires `confirm_switch: true` to change to another Runner. The selection survives client label changes and MCP-secret rotation.

Ordinary workspace/filesystem/execution/Git/job tools do not accept `runner_id`; the Worker resolves the selected Runner. `workspace_id` remains in tools that need a workspace. This prevents per-request accidental cross-host routing but does not create separate tenants: MCP clients with matching scopes and the same selected Runner share configured workspace IDs and bounded job history. Job creator information is audit metadata only.

The Worker separates offline Snapshot Authorization from live Runner Admission. Snapshot reads use only a validated immutable Active Policy and may expose safe Registry metadata while the Runner is offline; filesystem, execution, inspection, complete logs, input, and cancel operations require the current WebSocket session, epoch, credential generation, checksum triad, and an unfenced RunnerDO. Protected RPC frames include policy revision plus an expected checksum; a re-instantiated RunnerDO remains fenced and performs a one-time state-checked reconciliation before allowing forwarding.

## Local profile and service-manifest boundary

The local Runner profile contains the long-lived Runner token and current connection metadata, so it must be treated as credential material. Current central profiles contain no authoritative workspace paths; roots are delivered only in authenticated policy frames. Ordinary/user POSIX profiles use a `0700` directory and `0600` file; a dedicated system service intentionally uses the exact `0750`/`0640` shape within its root/service-group boundary so the service account can read the credential, with no group/other write bits. Windows ACLs are not inspected by the implemented `doctor` command. `status` redacts the token, and any locally retained administrative data should not be exposed.

The service adapter writes only marked, content-hashed manifests and refuses to overwrite/remove an unmarked or changed file. `runmesh install` invokes the Runmesh service provisioner, which creates the dedicated Runmesh service identity and Runmesh-owned directories on Linux and macOS, and applies the implemented Local Service ACLs to Runmesh-owned install/config/state/log/profile paths on Windows. It never changes a configured Workspace's owner or mode. Operators remain responsible for granting the service identity the minimum access needed for each configured Workspace. Current profiles record an explicit execution mode and central management; incomplete profiles are rejected and must be replaced through enrollment. Linux renders `User=runmesh` and `Group=runmesh`, macOS LaunchDaemon renders `UserName=runmesh`, and Windows uses `NT AUTHORITY\LOCAL SERVICE` at least privilege for `dedicated_user`. The authenticated dashboard defaults new machines to `dedicated_user`. Choosing the advanced `privileged_host` mode explicitly presents the warning/confirmation; that mode runs as root/SYSTEM and requires `--confirm-privileged-host`. `doctor --json` marks profile permission and installed/active service failures required, marks missing Python/Docker optional warnings, and does not inspect Windows ACLs after provisioning. Hosted bootstrap is a fixed signed-release contract and remains disabled by default unless the exact release is published, independently verified, a valid canonical external HTTPS origin is configured, and the exact release acknowledgement is enabled in the Worker deployment. Its one-command path treats the Worker HTTPS script as bootstrap root and its embedded Ed25519 key, not a downloaded keyring, as the release trust root; high-assurance operators use the independent offline portable-artifact route. When the gate is unavailable, use the manually verified portable artifact and CLI enrollment/install flow.

Hosted bootstrap has a conjunctive deployment gate: a valid canonical external HTTPS `RUNMESH_PUBLIC_ORIGIN` and the exact release acknowledgement are both required after independent release verification. Removing the acknowledgement closes future hosted-bootstrap rendering only; already downloaded scripts and outstanding codes may still be usable, and existing Runner credentials are not revoked. Review cached scripts, regenerate/revoke enrollment codes, and explicitly rotate/revoke Runner credentials when an immediate shutdown is required.

## Workspace and execution boundary

The MCP client sends a selected Runner plus workspace ID and relative path. `root_path` is private policy data delivered only through an authenticated Runner-only Policy frame; it is not returned to MCP, Workspace metadata, ordinary logs, or public APIs. The Runner rejects absolute/UNC/device paths, NULs, traversal, symlink/junction ancestry/escapes, write-through symlinks, and readonly writes. Patch installation uses bounded baseline validation, staging, atomic per-file replacement, and protected rollback.

Central management rejects local workspace add/remove. The host shell is not a sandbox.

Linux directory enumeration binds to an opened `O_DIRECTORY|O_NOFOLLOW` descriptor, verifies its device/inode against the accepted snapshot, and enumerates through `/proc/self/fd` while retaining that descriptor. Missing procfs fails closed rather than reverting to pathname traversal. Windows/macOS enumeration currently retains the pathname-revalidation implementation and its local ABA race limitation; do not claim hostile-local-mutator isolation there without an OS/native-handle boundary. Ordinary file reads have separate descriptor identity checks.

Search charges actual bytes read even when binary detection or UTF-8 decoding later fails. Its bounds are 4 MiB read bytes, 256 KiB per file, 1,000 candidate files, 10,000 directory entries, 1,000 directories, depth 16, and a cooperative five-second deadline. Limits set `truncated`; the deadline cannot interrupt a single hung operating-system I/O operation. POSIX Git executable discovery additionally requires root/current-effective-user ownership and safe modes for existing ancestors and the final executable; symlinked Git executables are rejected.

The new-client form defaults to `coding:read` only. The new-Runner form defaults to `dedicated_user`; `privileged_host` remains an explicit advanced choice with confirmation. These defaults do not rewrite existing clients, Runner profiles, or installed service identities.

See [security remediation and rollout notes](security-remediation.md) for compatibility requirements and remaining production acceptance work.

## Data minimization

Workspace roots are absent from protocol metadata. MCP errors expose allowlisted stable codes and recovery hints, not Runner absolute paths. Files, Git output, and logs are bounded/paginated. Complete filesystem data and logs remain on the Runner. RegistryDO stores bounded job metadata to support offline listing, not a complete copy of Runner state.

## Durable MCP audit contract

Only call, method, workspace/job identifiers, status/error code, timing and
connection generations are persisted. Requested tool output passes through the
Worker to its authenticated client, not into audit storage. File paths, file
contents, commands, search text, logs, patches, diffs and job input are excluded.
Metadata is limited to 1,000 records per Runner and seven days. The dev.4
upgrade purges legacy MCP audit rows once while preserving administrator,
session, Runner, policy and Job data. Read-side projection also strips legacy
payloads. See [rollout notes](security-remediation.md) for quota failures,
backup/PITR copies and confirming cleanup after deployment.

Registry settings outages return 503 before reserving a source password attempt;
they do not count as wrong passwords. Actual KDF work retains the shared CPU
budget. This does not eliminate distributed denial of service.

## Convenience enrollment commands

Hosted installer commands intentionally include a quoted single-use enrollment
code. Positional, `--code CODE`, and `--code=CODE` input is supported; omitting it
retains the hidden local prompt. This convenience choice exposes the copied
command to command history and process-argument capture. Treat the complete
command as a credential. It does not weaken release signature verification,
change the disabled distribution gate, or persist tool payloads in MCP audit.
