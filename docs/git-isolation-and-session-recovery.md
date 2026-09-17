# Git isolation and session recovery

[简体中文](git-isolation-and-session-recovery.zh-CN.md)

## Filesystem-root workspaces

Path containment and executable trust are different decisions. A child such as `/.git` or `/usr/bin` is inside `/`; the boundary helper normalizes dot segments, preserves root separators, and rejects sibling prefixes. Native Windows coverage includes drive roots, case folding, and UNC share boundaries.

Correct containment does not make a Git executable inside an untrusted workspace safe. Read-only Git inspection must not become a shell execution route. The trusted executable allow-list excludes both lexical and canonical workspace paths on POSIX and Windows, including conventional machine-wide Git directories. An empty trusted PATH fails closed instead of falling back to ambient executable discovery.

Filesystem-root Git inspection is explicitly unsupported under this trust model. The Runner rejects a canonical filesystem/drive root before reading Git metadata or creating a temporary isolated repository. All five public Git operations return `git_unavailable`, with a local diagnostic requesting a dedicated workspace directory. Other filesystem, execution, job, and context permissions are not disabled by this Git-specific decision.

MCP continues to redact raw Runner error messages and host paths. Its safe `git_unavailable` recovery hint asks an administrator to check the Git installation and configure a dedicated, non-filesystem-root workspace whose trusted Git executable is outside it. It does not expose private paths or recommend bypassing Git isolation.

For a centrally managed Runner, an authorized administrator must update the workspace in the control plane, for example to a dedicated repository at `/workspace`. Do not edit the local central profile, reuse a bootstrap bearer token as an administrator session, or recreate a repository at the filesystem root. Confirm desired/applied/reported policy agreement before repeating Git acceptance.

## Registry failures and reconnect behavior

| Registry result | WebSocket close | Meaning and recovery |
| --- | --- | --- |
| `401` or `403` | `4001`, `runner credentials rejected` | Explicit credential rejection; the Runner stops instead of retrying indefinitely. |
| `409` | `4000`, `stale runner session` | Session/sync fencing conflict; reconnect with the existing credential and perform a fresh handshake. |
| Availability failure, including `429` and `5xx` | `1013`, `control plane temporarily unavailable` | Retain the slower service-unavailable reconnect backoff. |

The mapping covers hello, the post-connect fence before welcome, heartbeat, sync, job events, policy acknowledgements, and session probes before RPC replies. A conflict still rejects pending bridge replies and never authorizes stale output. Local pre-welcome frames and protocol mismatches are rejected separately, without claiming that credentials were revoked. Explicit revoke/rotate operations retain their existing credential-generation fences.

The Runner records retryable `4000` closure as `session_conflict` and uses the existing jittered network reconnect backoff. The same credential is retained. Close codes, not arbitrary peer-provided reason text, determine whether a failure is fatal. This does not prove that any earlier untraced disconnect was caused by a Registry `409`.

## Regression checks and rollout boundary

Regression tests exercise root/ordinary/sibling/traversal path cases; root fail-closed behavior for all five Git methods; real status, diff, log, show, and blame in a dedicated read-only workspace; upstream failure categories across transport paths; withheld stale RPC results; and real WebSocket conflict/retry behavior. Existing ownership, symlink, metadata race, and handshake tests remain required.

Source tests do not replace acceptance of an installed signed Runner. Changing source does not modify central workspace policy or upgrade a service. Preserve immutable published assets and the current Runner. A no-deployment delivery must not push into an automatically deployed branch; retain a local reviewed commit until deployment is authorized.
