# Central OAuth and ephemeral sessions (development)

[简体中文](central-oauth.zh-CN.md)

**W06 implements administrator-mediated OAuth and operation-local legacy MCP
sessions. Central bindings remain test-only; this is not a production activation.**

## Identity and supported providers

An administrator explicitly delegates an upstream authorization to one Runmesh
MCP client credential generation. Client IDs are not natural-person accounts.
The binding includes the profile, client, secret generation, resource endpoint
and approved OAuth configuration digest. Provider authorization, tool approval
and client capability grants remain separate. OAuth grants no machine permission
and requires no software installation on a Runner.

This batch supports pre-registered **public** OAuth clients, authorization code,
PKCE S256, bearer access tokens, explicit resource indicators and RFC 9207 `iss`.
Provider metadata must affirm the pinned issuer/endpoints, S256, response type
`code`, grant `authorization_code`, client authentication `none`, and issuer
response support. No dynamic registration, confidential client secret, automatic
scope upgrade, sender-constrained token or arbitrary authentication redirect is
implemented.

The optional `CENTRAL_OAUTH_POLICIES` is a JSON array, without tokens or secrets:

```json
[{"profile_id":"docs","resource":"https://remote.example.com/mcp","issuer":"https://login.example.com","metadata_endpoint":"https://login.example.com/.well-known/oauth-authorization-server","authorization_endpoint":"https://login.example.com/authorize","token_endpoint":"https://login.example.com/token","oauth_client_id":"registered-public-client","scopes":["read"]}]
```

Endpoints must be pinned public HTTPS URLs; authorization/token endpoints share
the issuer origin. Metadata follows the RFC 8414 well-known location and cannot
add destinations. Public-only Worker fetch routing remains a deployment
requirement. Requests never follow redirects or forward incoming tokens/cookies.

## Administration

Use the existing profile API with `action: "create_oauth"`, `connector_id` and
`endpoint`; the profile ID comes from the path. New profiles are disabled with
`credential: null`, not a fake bearer. Existing profiles cannot silently change
authentication mode. Enable/disable does not require decryption keys.

The following POST paths under `/admin/central/oauth/` require the existing
administrator session, same-origin request and matching CSRF header/cookie:

| Action | Body | Result |
| --- | --- | --- |
| `begin` | profile_id, principal: {client_id, secret_version}, expected_revision | Pending link and approved authorization URL |
| `complete` | state, iss, exactly one of code/error | Single-use callback and safe link metadata |
| `inspect` | Same selection shape; expected_revision may be 0 for reads | Metadata, never tokens/verifier |
| `revoke` | Selection plus observed revision | Local revocation and removal of token ciphertext |

There is no ADMIN_TOKEN or MCP-token fallback. Register exactly
`RUNMESH_PUBLIC_ORIGIN + /admin/central/oauth/callback` with the provider. Open the
returned URL in the administrator's browser. The fixed landing page removes
query parameters from history before a same-origin protected POST; Strict cookie
settings remain unchanged. Different sessions, issuer/configuration changes,
expired state and callback reuse are rejected. Callback text is never inserted
into HTML. Infrastructure logs may still see the initial callback URL: disable
query-string logging there and do not log authorization URLs.

After linking and enabling, discovery accepts `principal` alongside
`expected_revision` at `/admin/central/discovery/{profile_id}`. OAuth discovery
requires it. The resulting catalog still needs approval and independent grants.
W08 now provides the [administrator and reusable toolset console](central-administration.md);
OAuth still requires the explicit provider policies and independent grants above.

## Tokens, recovery and sessions

PKCE verifiers and tokens use independent-keyring AES-GCM encryption with
owner/link/generation-bound contexts. SQLite stores only ciphertext and metadata.
Temporary byte buffers are cleared; JavaScript strings cannot be reliably
zeroized. This does not protect a compromised runtime. Retain old vault keys
until links have refreshed or been replaced; no bulk OAuth rekey task is added.

Refresh is demand-driven near expiry. Concurrent requests share one refresh but
each waiter rechecks its own authorization. A persisted claim precedes using a
rotating refresh token. An unknown result or restarted in-flight claim requires
reauthorization, never token replay. Scope expansion and reuse of the same refresh
token are rejected. If the response omits a replacement refresh token, the new
access token is usable but the old refresh token is discarded.

Revocation is local: it fences future use and removes local token ciphertext.
It does not revoke provider tokens, stop a dispatched effect or roll it back.
Client credential revocation/generation changes block old links. Refresh, 401,
and lost responses never automatically replay tool calls.

Stateless MCP remains the default. A 2025-11-25 egress rule may explicitly add
`"session":"ephemeral"`. The session ID is captured only during initialization,
pinned to one operation/credential, and never exposed to the inbound client.
Unexpected replacements fail closed. Each operation creates a fresh session:
there is no persistence, pool, automatic reconnect, GET subscription or resume.
Normal closure makes at most one bounded DELETE when still authorized. Failure,
cancellation or revocation may prevent remote cleanup; local state is discarded.
A session expiry does not replay the call; a new explicit operation starts fresh.

## Budgets and verification boundary

Limits: 64 provider policies, 64 pending flows, 1,000 links per owner, 4 active
authorization operations, 16 KiB command bodies, 32 KiB provider responses,
2 KiB tokens, five-minute callback TTL and five-second individual operations.
Flow expiry cleanup is bounded and demand-driven, without alarms or polling.
Session cleanup is bounded to one second. These are ceilings, not performance
guarantees. Existing bearer/native paths do not acquire OAuth dependencies.

No deployment binding or secret is installed automatically. Old Worker code does
not understand OAuth-only profiles; do not reset state or grant machine access
to disguise rollback incompatibility. Fixture tests do not prove real browser
consent, public-provider interoperability, or production quotas.

References: [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html),
[RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html),
[MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[MCP sessions](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
