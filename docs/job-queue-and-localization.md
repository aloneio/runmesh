# Share a Runner and choose the UI language

Authorized MCP clients can select the same Runner and share its execution capacity. Each client keeps its own selection and must satisfy the workspace's permissions.

## Submit and follow queued work

Default process concurrency is **two**; operators can configure **1–64** execution slots. When slots are full, a compatible Runner can queue up to **32 Jobs total** and **eight per originating client**. It uses FIFO within each client and round-robin selection across clients. Admission reservations are capped at 64.

Both foreground and background calls return a queued Job ID immediately. Follow that ID with `job get/logs`. Set `queue=false` when you want immediate admission only; a full waiting queue returns `queue_full`. Job reads and controls remain available independently of execution slots.

A duplicate `request_id` within one client/workspace returns the same Job when its launch fingerprint matches. Save the original Job ID and request ID. Cancelling while waiting or awaiting authorization prevents launch. After a Runner restart, unstarted persisted queued Jobs become interrupted; inspect them before submitting replacement work.

## Authorization at launch

Queueing requires queue protocol 1, available from Runner **0.1.3**, and a compatible Worker. The Worker supplies a signed launch context valid for at most one hour, bound to client/Runner generations, workspace, policy and command input.

Immediately before a queued launch, the Runner requests current authorization through `runner.queue_check`. Revocation, rotation, policy/lifecycle changes, expiry or unavailable verification deny launch. The Runner also rechecks local policy and cancellation before creating the process.

Scheduling responds to admission, completion, cancellation and explicit recovered-state inspection. Those authorization requests and optional history operations have normal resource costs. Concurrent commands share the host and workspace, so consider their interaction when raising the execution limit. JobManager integrations can configure queue capacity; the administrator UI exposes the supported product settings.

## Choose the UI language

Use the administrator interface's language selector for English or Chinese. Switching language reloads the page. Selection priority is explicit `lang`, saved preference cookie, then browser language preferences.

Page text and titles use the selected language. Product names, identifiers, user labels, code, logs, input values and copied commands retain their original values.

Dashboard navigation and history loading are request-driven. Use Load/Refresh or reload the page when you need a fresh observation. Language changes are served by the Worker; installing a newer Runner is a separate action required for new Runner capabilities.
