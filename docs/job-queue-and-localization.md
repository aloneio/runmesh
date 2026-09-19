# Share a Runner and choose the administrator UI language

## Admission and fairness

Multiple authorized MCP clients can select the same Runner. Selection remains per client; it never grants workspace permissions or switches another client. Default process concurrency is two; operators may explicitly configure 1–64 execution slots. Waiting is bounded to 32 jobs total and eight per originating client, with FIFO within a client and round-robin selection across clients. Foreground and background calls return queued IDs immediately. `queue=false` preserves fail-fast behavior, while full queues return `queue_full`. Admission reservations are bounded to 64. Existing retained-Job and log-byte limits still apply. Queue capacity is configurable to JobManager integrators, not a new administrator permission.

Reads and Job control do not consume process slots. Concurrent callers do not obtain filesystem isolation: baseline checks and workspace permissions still apply, and increasing process concurrency is a separate operator decision. One queued authorization is processed per admission turn, so failure does not hold the admission lock while draining an entire unavailable queue.

## Starting a queued command

Worker and Runner negotiate queue protocol 1. Legacy peers receive no new frame. The Worker signs an hour-bounded context for the authenticated client generation, Runner lifecycle and credential generation, workspace, policy and command-input digest. Caller-supplied contexts are discarded. This context is not permission to execute later.

Before a queued spawn, the Runner sends `runner.queue_check` on its current authenticated WebSocket. RunnerDO verifies the signature, current transport and policy, then asks Registry for the client's current scope/workspace decision. A final local fence precedes the response; Runner rechecks local policy generation and cancellation before spawn. Revocation, rotation, changed policy/lifecycle, expiry or unavailable verification denies launch. There is no stale-permission fallback or automatic replay after denial.

Cancellation while waiting or awaiting authorization prevents spawn. Duplicate request_id within one client/workspace returns the same Job and must have the same launch fingerprint. A Runner process restart marks unstarted persisted queued jobs interrupted rather than executing work whose authorization context was lost. Existing running-process recovery remains unchanged.

Scheduling reacts to admission, completion, cancellation and explicit recovered-state inspection. No idle queue poll, new database table or broker is added. Queued execution incurs necessary live authorization requests; existing batched/no-record history remains in force. This is not a zero-cost or unlimited queue.

## Choose the UI language

The administrator interface supports English and Chinese. Use the language selector to change it; switching language reloads the page. An explicit `lang` choice takes precedence over the saved preference cookie, which takes precedence over the browser's language preferences.

Page text and titles use the selected language before display. Product names, technical identifiers, user labels, code, logs, input values and copied commands are preserved as data. Changing the display language does not translate or modify your commands or output.

Dashboard navigation and history refresh happen when requested. Leaving a page open does not start background history polling. Reload or use the relevant refresh control when you need a new observation.

## Runner compatibility

Queued execution requires queue protocol 1, available from Runner 0.1.3, and a compatible Worker. Updating only the Worker cannot enable queueing on Runner 0.1.2. Install a verified compatible Runner release separately; publishing or deploying Worker code does not restart or upgrade the service. UI language changes are served by the Worker and do not require a Runner upgrade.
