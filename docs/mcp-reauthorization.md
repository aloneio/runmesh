# MCP reauthorization outcomes (AR02)

Initial URL authentication is not the last authorization check. A credential can be rotated, revoked or have its scopes changed while request processing awaits. The registration layer therefore retains its one existing Registry revalidation before invoking a tool.

The revalidation adapter now returns a discriminated outcome: `allowed` with validated current scopes; `denied` for explicit 401/403/404 from this internal endpoint or a structurally valid principal/generation mismatch; `unavailable` for transport, timeout, 429, 5xx or unexpected HTTP statuses; `malformed` for an invalid successful response. Only a validated allow reaches the handler. The existing RunnerDO final authorization and local send fence remain unchanged.

An unavailable dependency produces `registry_unavailable`, availability, `operation_state=not_started`; it does not claim the URL has been revoked or ask the operator to re-enroll. Malformed success produces `authorization_response_invalid`, `not_started`, and operator investigation. Neither case dispatches a command, modifies scopes or resets a credential. Real denial still produces `permission_denied`. Read-only scopes still cannot invoke writes, shell, input or cancellation.

The one request has a five-second request-local deadline, a 16 KiB body budget and at most 256 reads. Late or failed responses are cancelled. There is no retry, recurring timer, authorization cache, database mutation or extra RPC. Current identity/scopes are projected through a whitelist; error bodies, raw URLs, stack traces and local paths are not returned. The adapter remains an internal Worker component, not a new public tool or deploy variable.

Unexpected exceptions from an already invoked tool retain `internal_error` with unknown outcome. The human recovery hint now agrees with that state: inspect an existing Job/change receipt, do not blindly repeat a command or write. This does not claim that already completed OS effects can be rolled back.

Integration fixtures first authenticate a real isolated Registry and then fault only the later revalidation. They cover unavailable and malformed responses, real revocation, current scope restrictions, one-call behavior, no dispatch, and recovery using the same credential. Request/body deadlines and output projection have narrow tests without a live account dependency.
