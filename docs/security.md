# Security model

Runmesh combines MCP client scopes, Runner policy, workspace permissions and the host's OS identity. Use these controls to grant each client the access its work requires. Setup steps are in the [administrator guide](admin-guide.md) and [user guide](user-guide.md).

## Protect each credential

| Credential | Purpose and storage |
| --- | --- |
| Administrator password | PBKDF2-HMAC-SHA-256 with a random salt and versioned verifier |
| Browser session | Random session/CSRF values; Registry stores hashes, version and expiry; cookies use `Secure`, `HttpOnly` and `SameSite=Strict` |
| MCP URL secret | A 256-bit base64url path credential at `/<secret>/mcp`; Registry stores its SHA-256 verifier and short prefix |
| Enrollment code | A 43-character single-use code for `POST /runner/enroll`; Registry stores its verifier, validity window and use state |
| Runner token | Returned once at enrollment and kept in the private local profile; Registry stores a peppered HMAC verifier |
| Internal control secret | HMAC protection for method/path/body between the Worker and Durable Objects |

Complete first administrator setup before exposing an uninitialized instance to untrusted visitors: the first successful setup owns it. Setup uses password confirmation, CSRF and same-origin checks. Once initialized, the setup route is closed.

Use the enrollment validity window shown in the administrator interface. Its underlying default is 30 minutes when no override is supplied. Regenerating a code replaces any unused code for that Runner. After redemption, the local profile retains the Runner token, not the enrollment code.

MCP secrets appear on the one-time create/rotate page. Treat the full URL as a credential: keep it out of shared screenshots and logs, configure infrastructure log redaction, and rotate it after suspected exposure. The application sanitizes its own logs; browser history and provider access logs require separate handling.

## Rotate, revoke or delete access

Changing the administrator password invalidates existing sessions and rejects an in-flight login verified against the old password generation. MCP calls and Runner-selection updates recheck the client credential generation; invalid, rotated and revoked URL credentials return `404` at initial authentication.

Runner rotation/revocation closes its prior socket and invalidates the old connection/credential generation. Revoke retains central configuration and history for review. Delete removes the Runner's central configuration, SQLite Job metadata and client selections. Host Jobs and separately retained cloud history follow their own cleanup procedures.

These actions affect authorization and routing. Already admitted mutations and running host processes can remain effective. **Cancel a Job explicitly when it should stop, and inspect existing changes before recovery.** See [call recovery](mcp-agent-call-contract.md).

## Choose workspace and host access

Each MCP client has a sticky active Runner. Use `runner_select`; switching an existing selection requires `confirm_switch:true`. Workspace operations then address workspace IDs on that Runner. Clients with matching scopes and workspace permissions share Jobs and Contexts there; creator identity is audit metadata.

Live operations require the current connection/session and agreement on desired, applied and reported policy revision/checksum. Offline history reads use retained policy-authorized metadata. See [permission diagnosis](permission-model.md) for the individual checks.

The Runner's file tools accept relative paths and check traversal, links/junctions, path identity and read-only policy. Patch application uses baseline checks, staging, per-file atomic replacement and checked rollback. Inspect partial or uncertain failures before another mutation.

Host shell uses the Runner's OS identity. The workspace sets its initial directory; the command can access whatever that account's host permissions allow. New Runners default to `dedicated_user`: Linux uses `runmesh:runmesh`, macOS uses `UserName=runmesh`, and Windows uses `NT AUTHORITY\LOCAL SERVICE`. Grant that identity the required workspace access. Use VM/container isolation for commands that need an additional host boundary.

The advanced `privileged_host` mode runs as root/SYSTEM and requires explicit confirmation, including `--confirm-privileged-host` in the CLI. Existing service identities and client permissions retain their configured values; new MCP clients default to `coding:read`.

## Protect the local profile and installation

Keep the Runner profile private because it contains its long-lived token. Ordinary/user POSIX profiles use directory/file modes `0700`/`0600`; dedicated services use `0750`/`0640` within their root/service-group boundary. `status` redacts the token. `doctor --json` checks required profile/service conditions and reports missing Python/Docker as optional warnings; inspect Windows ACLs separately.

`runmesh install` provisions the Runmesh service identity and owned directories, with Local Service ACLs on Windows. Workspace owners and modes are administrator-managed. Service manifests carry ownership markers and content hashes; changed or unmarked manifests require operator inspection before replacement or removal.

Centrally managed workspace roots are configured in the administrator interface and delivered in authenticated policy frames. Public metadata omits them. File content and command/log output can still contain paths that an authorized client requests.

Hosted installation requires a verified release in the selected channel and a validated HTTPS origin. Production follows reviewed release state; **0.1.4 is a candidate and its stable gate is closed**. Development uses verified signed prereleases. Ordinary Cloudflare routing derives the origin from a matching request URL and Host; `RUNMESH_PUBLIC_ORIGIN` is an optional override.

The hosted script and embedded Ed25519 key form the one-command installer trust path. Use [portable artifact verification](portable-runner-installation.md) when you need an independently trusted artifact/keyring. Hosted commands contain a single-use code that can enter shell history or process arguments. To use a hidden prompt on Windows, remove `-NonInteractive` and run in an interactive administrator terminal.

An explicit empty `RUNMESH_SIGNED_RELEASE_AVAILABLE` disables future hosted-script rendering. Downloaded scripts and outstanding codes retain their own validity; for an immediate credential shutdown, invalidate enrollment codes and rotate/revoke the affected Runner token. See [deployment](deployment.md).

## Browser and login protection

Admin changes require CSRF and same-origin checks. HTML uses `Cache-Control:no-store`, `Referrer-Policy:no-referrer`, `nosniff` and frame blocking. The administrator page authorizes its application script with a fresh nonce:

```text
default-src 'none'; connect-src 'self'; img-src 'self' data:;
style-src 'unsafe-inline'; script-src 'nonce-<fresh-random-value>';
form-action 'self'; base-uri 'none'; frame-ancestors 'none'
```

The nonce supplements escaping; inline styles are permitted. Keep all supplied page content escaped in its HTML/attribute/script context.

Setup/login allow the first five source attempts, then apply a 30-second block with repeated-failure backoff up to 15 minutes. Each kind also has a 120-attempt global KDF budget per 60 seconds. Source state is capped at 2,048 keys including reserved slots, with one-hour retention. A successful operation clears its own source bucket while the global budget remains shared.

Source keys are HMACs derived from Cloudflare's edge-supplied `CF-Connecting-IP`; raw IP addresses are excluded from stored throttle state. Missing/malformed metadata shares an unattributed bucket. Preserve that trusted edge boundary when adding a proxy. Storage failures use bounded in-memory protection and show a warning; those reservations last only for the running instance. Global exhaustion can affect all users, so configure any additional Access, WAF/rate limits or MFA at the deployment layer.

A Registry settings outage returns 503 before reserving a password attempt. Actual KDF work still counts toward the shared CPU budget.

## Filesystem checks and limits

Read-only Git inspection requires a dedicated workspace and a trusted executable outside it. Filesystem/drive-root workspaces return `git_unavailable`; see [Git access](git-isolation-and-session-recovery.md).

Linux directory enumeration uses a verified `O_DIRECTORY|O_NOFOLLOW` descriptor through `/proc/self/fd`, so procfs is required. Windows/macOS use pathname revalidation, which has a local replace-and-restore race limitation. Protect the host from concurrent untrusted filesystem mutation. Ordinary file reads additionally check descriptor identity.

Search limits are **4 MiB** total bytes, **256 KiB** per file, **1,000** candidate files, **10,000** entries, **1,000** directories, depth **16** and a five-second deadline checked between I/O operations. Reaching a bound sets `truncated`; individual OS calls can exceed the checked deadline.

## Data and audit retention

Requested file content, Git output and log pages pass through the Worker to the authorized client. Files and retained logs stay on the host; logs remain subject to count, byte and configured age limits. Cloud Job history stores bounded recent metadata in D1 by default in production, or SQLite compatibility mode. Keep independent backups for long-term data.

Durable MCP audit contains call/method, workspace/Job IDs, status/error code, timing and connection generations. File paths and contents, commands, search text, logs, patches, diffs and Job input stay outside that audit. Each store caps metadata at **1,000 records per Runner** and hides entries older than **seven days**. Cleanup backlog can extend physical retention; backend transitions, backups and point-in-time recovery have separate lifetimes.

See [history isolation](quota-resilience.md) for recording preferences, provider failures and storage changes, and [upgrading](upgrading.md) for release procedures.
