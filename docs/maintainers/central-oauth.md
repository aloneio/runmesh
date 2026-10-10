# Central OAuth and operation-local sessions

> Maintainer reference: interfaces, protocol and verification boundaries. For everyday use, see the [user guide](../central-oauth.md).

[简体中文](central-oauth.zh-CN.md)

## Connect from the control panel

Enter a public HTTPS MCP URL and select OAuth in /admin/central. Runmesh discovers resource and provider metadata, prefers OAuth client metadata documents, and otherwise dynamically registers a public client. Unsupported providers fail explicitly. There is no manual client secret, per-provider environment policy or per-client OAuth assignment.

A credential-free discovery probe reads WWW-Authenticate; its resource metadata URL and scopes take precedence over well-known locations. Missing challenges use well-known discovery. The probe never initializes a session or invokes a tool. All destinations are bounded public HTTPS without redirects, private destinations or forwarding inbound credentials.

Authorization belongs to the saved connection. After successful connection and automatic tool discovery, every authenticated instance client can use the service. Each caller is revalidated; publication does not grant native Runner or workspace permissions.

## Authorization and credential lifecycle

The protected /admin/central/connections/begin, complete and revoke endpoints require the administrator session, same origin and CSRF checks. The browser callback is /admin/central/connections/callback. PKCE, session-bound one-use state, issuer verification, exact profile revision and origin checks fence the exchange. The callback page removes query parameters before its protected POST and never inserts callback text into HTML. Deployment logs must exclude callback queries and authorization URLs.

OAuth client data, verifier and tokens use AES-256-GCM encryption. HKDF-SHA256 derives a non-exportable key from the existing `INTERNAL_CONTROL_SECRET`, separated by OAuth purpose and Durable Object namespace. No additional deployment variable is required. Authenticated encryption also binds ciphertext to the operation context. Profile metadata contains no upstream secret; OAuth storage owns credential state. Read APIs expose metadata only. Temporary byte buffers are cleared, but JavaScript strings cannot be reliably zeroized and encryption does not protect a compromised runtime.

All three encrypted values use the shared `platform/secret-storage.ts` adapter and `contracts/secret-storage.ts` contract. The adapter preserves the existing ciphertext format, so moving it does not require reconnection. Each value has a 64 KiB UTF-8 plaintext budget; ciphertext and record bounds derive from that budget, including space for a full access-token and refresh-token pair. Key derivation and base64url encoding have one implementation each.

Credential serialization uses the feature-independent `contracts/json.ts` implementation. Discovery metadata has a shared 32 KiB UTF-8 byte budget used by both protocol validation and record sizing, so multibyte text is measured consistently.

A durable claim precedes exchange or refresh to prevent concurrent reuse. Refresh is demand-driven; waiting requests recheck their own admission and use leases that validate the current OAuth revision. Unknown outcomes require reconnection and are not replayed. Preserve `INTERNAL_CONTROL_SECRET` during upgrades; rotating it requires OAuth reconnection. There is no stored raw-key cache or compatibility path for the former separate keyring.

Disconnecting an account revokes local state and fences leases. It does not revoke tokens at the provider or roll back dispatched effects. Client revocation independently blocks that client without disconnecting the shared service. A 401 or credential change never automatically replays tools/call.

## Sessions and module boundaries

The adapter negotiates supported MCP protocol versions. An upstream session created during initialization is bound to one operation and credential. Unexpected replacement fails closed. There is no persistent session pool, automatic reconnect, GET subscription or resume. Normal closure sends at most one bounded DELETE while admission remains valid; cancellation or revocation may prevent cleanup, and local state is discarded.

Managed OAuth application code owns lifecycle ordering through SDK-free ports. Protocol adapters own discovery and bounded HTTP; storage owns atomic state. Only the composition root wires implementations together. The former client-bound OAuth, manual bearer profile and environment-policy implementations are removed. Their HTTP paths have no handlers and return ordinary unknown-route responses.

## Verification boundary

Reconnect first reloads the saved connection and then starts one new authorization attempt. A failed discovery does not require a separate manual refresh. Failed state reads and paused or removed connections prevent the handoff.

Before tool discovery, an existing connection's current catalog returns HTTP 200 with an empty state; a missing connection or requested snapshot still returns 404. Discovery that requires authorization and has not started returns HTTP 200 with an authorization-required state, allowing the panel to offer reconnection. Other failures retain their error responses. Reopening the panel after an interrupted OAuth return resumes discovery automatically and reuses the initial catalog read.

Authorization checks credential encryption before contacting the provider. A missing or invalid `INTERNAL_CONTROL_SECRET` returns `oauth_configuration_required` (503, `not_started`) without contacting the provider or replacing an existing account. Restore the existing deployment secret if it becomes unavailable. A normally configured instance needs no additional OAuth setup: users enter the MCP URL, select OAuth and continue to the provider's authorization page. Configuration failures are presented separately from unsupported or unavailable providers.

Tests cover encryption binding, key rotation, callback identity/origin, refresh claims, revocation, session cleanup and no replay. Local protocol fixtures do not prove consent with every real provider. Deployment activation and external consent evidence remain in [the rollout ledger](../central-rollout.md).

See [the product workflow](central-administration.md), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) and [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
