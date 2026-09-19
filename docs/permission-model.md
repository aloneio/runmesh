# MCP → Worker → Runner authorization and diagnosis

Use this page to understand why an MCP operation is allowed or denied and to diagnose access problems without granting more permissions than necessary. Check the deployed Worker and installed Runner versions when comparing their behavior with current documentation.

## Independent boundaries

A permitted public operation needs both its explicit MCP scope and the intersection of the client scope ceiling, client-to-Runner override, active Runner permissions and enabled workspace permissions. `coding:read` authorizes read tools, `coding:write` authorizes edit, and `coding:exec` authorizes execution and job control. The ceiling helper includes execution dependencies but does not let the exec scope replace the separately required scope for public read/edit tools. Explicit dependencies for stored policy remain read before edit/job-control, and read+edit+job-control before Host shell.

`workspace_list` returns the requesting client's effective policy permissions after applying these limits. Public tool scopes remain independent: with read+exec but no write scope, the policy ceiling alone does not make the edit tool available. Each tool checks its exact scope.

An absent override inherits the scope/Runner/workspace ceilings. A stored override that is present but invalid is locked, not treated as absent. Revoked clients have no effective authorization. Never repair an invalid permission record by granting implied rights.

## Request identity and policy consistency

The Worker validates the secret URL with the Registry, then captures only client ID and secret generation. Every tool callback revalidates that exact generation and reloads scopes. Changing the selected Runner also checks this generation at the selection update, so an old in-flight request cannot change the selection after its credential has been rotated or revoked. No raw secret is forwarded to the Runner or recorded in the audit body.

Before forwarding a live operation, a single synchronous Registry decision binds current client state and generation, explicit scope, sticky Runner selection, method, workspace or job identity, current policy revision/checksum, and the effective permission bit. Authorization failure or an unavailable decision prevents forwarding.

The Worker signs the bridge body including its non-secret MCP principal. RunnerDO repeats authorization after asynchronous access/policy reconciliation, then checks its local policy/session admission fence immediately before socket send without another await. The public tool API cannot supply or replace this principal. Trusted HMAC operator RPCs are a separate privileged lane retained for compatibility; they are not access through an MCP secret URL. Raw operator signing secrets must remain restricted to control-plane operators.

These checks define an admission boundary, not retroactive cancellation. A revocation already committed before the final authoritative decision is rejected. A request already admitted, an OS syscall already issued, a committed patch or an already running child cannot be promised to disappear atomically when a later independent revocation occurs. Use explicit cancellation and reread mutation state instead of blindly repeating a timed-out write.

## Runner-local protection

Runner PathPolicy tracks an in-process generation and rejects obsolete resolved workspace objects. Filesystem resolution and snapshot validation check the generation around asynchronous work. Read-only dispatch rejects data if the policy changes before it returns.

Job start captures the policy generation before entering the start queue, rechecks after cwd resolution, and rechecks immediately before process creation. Patch checks its captured generation around baseline revalidation inside the commit lock. Old queued work cannot treat a newer policy as proof that its old authorization is still valid. Existing rollback, temporary cleanup and committed-result semantics remain in force.

The Runner does not receive the MCP credential and cannot itself validate client scopes. That remains a control-plane responsibility. It independently enforces its active local workspace policy, expected job workspace and current wire policy revision. Keep these checks even when the Worker is trusted.

## Task access and operating-system permissions

Jobs are shared at the authorized workspace boundary, not exclusively with their creator. A read-authorized client may inspect a job or read its logs even when another client created it; this is the product contract, not by itself an ownership bypass. Job input and cancellation require the exec scope plus effective job-control permission, and the actual job workspace must match the Registry-authorized expected workspace. Input to an existing interactive process is powerful and must not be classified as read-only.

Host shell uses the Runner's operating-system identity. The workspace controls initial cwd and application permission, not a sandbox root. A `privileged_host` root/SYSTEM Runner must be treated as a host administration capability. Do not resolve an authorization error by blindly enabling every permission, recursively applying chmod 777, or switching an unrelated service to root.

## Diagnosis order and safe repair

Compare actual deployed Worker and Runner versions with source; a repository version is not deployment evidence. Compare desired, active and reported policy revision/checksum, and the Runner connection/session/credential lifecycle. Reconnect or policy-ack transitions may temporarily fail closed. Distinguish `policy_pending`/`stale_policy`, `insufficient_scope`, `readonly_workspace`, `permission_denied`, `busy`, `runner_offline` and operating-system access failures. A last-known online state can coexist with an unsuccessful live RPC; that is not proof that all layers are reachable.

Check the specific client's scopes and Runner override, the Runner policy, enabled workspace and OS filesystem identity. Do not print the client's URL secret or Runner token. Keep the timestamp, stable error code and non-secret Runner/workspace identifiers when asking an operator for help.

For an upgrade, deploy compatible Worker code and install a verified Runner release using an independent console with a recovery plan. Preserve a way to reach the host while its Runner service restarts. Updating the Worker does not update the installed Runner; see [upgrading](upgrading.md).
