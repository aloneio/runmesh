# Shared Runner queue and single-locale administrator UI

## Admission and fairness

Multiple authorized MCP clients can select the same Runner. Selection remains per client; it never grants workspace permissions or switches another client. Default process concurrency is two; operators may explicitly configure 1–64 execution slots. Waiting is bounded to 32 jobs total and eight per originating client, with FIFO within a client and round-robin selection across clients. Foreground and background calls return queued IDs immediately. `queue=false` preserves fail-fast behavior, while full queues return `queue_full`. Admission reservations are bounded to 64. Existing retained-Job and log-byte limits still apply. Queue capacity is configurable to JobManager integrators, not a new administrator permission.

Reads and Job control do not consume process slots. Concurrent callers do not obtain filesystem isolation: baseline checks and workspace permissions still apply, and increasing process concurrency is a separate operator decision. One queued authorization is processed per admission turn, so failure does not hold the admission lock while draining an entire unavailable queue.

## Starting a queued command

Worker and Runner negotiate queue protocol 1. Legacy peers receive no new frame. The Worker signs an hour-bounded context for the authenticated client generation, Runner lifecycle and credential generation, workspace, policy and command-input digest. Caller-supplied contexts are discarded. This context is not permission to execute later.

Before a queued spawn, the Runner sends `runner.queue_check` on its current authenticated WebSocket. RunnerDO verifies the signature, current transport and policy, then asks Registry for the client's current scope/workspace decision. A final local fence precedes the response; Runner rechecks local policy generation and cancellation before spawn. Revocation, rotation, changed policy/lifecycle, expiry or unavailable verification denies launch. There is no stale-permission fallback or automatic replay after denial.

Cancellation while waiting or awaiting authorization prevents spawn. Duplicate request_id within one client/workspace returns the same Job and must have the same launch fingerprint. A Runner process restart marks unstarted persisted queued jobs interrupted rather than executing work whose authorization context was lost. Existing running-process recovery remains unchanged.

Scheduling reacts to admission, completion, cancellation and explicit recovered-state inspection. No idle queue poll, new database table or broker is added. Queued execution incurs necessary live authorization requests; existing batched/no-record history remains in force. This is not a zero-cost or unlimited queue.

## UI and language

The prior client script translated dynamically mounted pages unconditionally, including English views, and applied partial string substitutions. Some controls embedded both languages. Page opacity/position cross-fades also changed the display during navigation.

HTML now selects one locale before paint: explicit lang, exact preference cookie, then browser language preferences. Content-Language, Vary and no-store headers agree. No visible text-node translation runs afterward. Language switching reloads the full shell; ordinary admin navigation remains explicitly requested, with no background refresh. Page-container and cross-document fades are removed.

Canonical source strings and Chinese translations are separate. Static controls, history/retention settings, log actions and administrator errors have coverage gates. Product names, technical identifiers, user labels, code, logs, secrets, input values and copied commands remain data. Escaping, entity handling, CSP and prototype-safe dictionary lookup are covered by tests.

An isolated Chromium check covers English/Chinese dashboard rendering, shell navigation, panel text and geometry, idle DOM/network activity and a 390px mobile viewport. The check uses local test accounts in a new temporary browser profile, not the operator's session. The observed panels had zero idle DOM changes, zero idle admin requests, no script exceptions and no page horizontal overflow.

## Release boundary

These changes require Runner 0.1.3 for queue negotiation. Worker-only deployment cannot enable queueing on an installed 0.1.2 Runner. Preserve old immutable assets and the live service. Prepare the candidate on protected GitHub main, validate the exact portable artifact, publish and independently verify it, then activate through GitLab main. Never push a closed candidate installer gate into production. Publishing is not a service upgrade or restart.

Tests include real multi-client queued execution plus concurrent file reads, fairness, limits, cancellation, idempotency, policy changes, signed-context tampering/expiry/identity mismatch, authorization races, restart non-replay, locale selection/escaping and browser navigation. Existing quota and enrollment recovery checks remain mandatory.

Reference: https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/

Post-deployment locale verification also checks compound browser titles (login, setup, enrollment and administrator pages). Every known UI segment is translated rather than only the first segment; this Worker-only follow-up does not modify the immutable Runner package.
