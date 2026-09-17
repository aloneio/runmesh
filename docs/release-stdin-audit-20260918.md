# Runner stdin delivery audit - 2026-09-18

## Scope

This continuation starts from clean candidate `85b262cbc5e544e0d4f8d461aaf2fa6497457142`, preserving the earlier FIFO/descriptor repairs. Its prior 26 local gate results and browser run were verified, not treated as approval for this repair. The independent audit repository is separate from the original dirty dev checkout. Commands and tests run as the repository owner xwzy; no installed Runner service or production deployment is changed.

## SEC19: input delivery can hang or falsely acknowledge errors

JobManager.input previously waited only for drain/error when write returned false. A silent stdin close could therefore leave its promise pending forever. After successful drain the paired error listener remained installed, accumulating over repeated input. Writes that returned true were acknowledged without observing their completion callback, so a later write error could follow an accepted receipt. The EOF callback ignored its error argument and could resolve success before the stream error event arrived. EOF success also left its per-call error observer behind.

Six public-JobManager regressions failed before the repair: repeated-backpressure listener cleanup, silent close, asynchronously failed buffered writes, failed EOF, EOF-only listener cleanup, and combined UTF-8 input/EOF listener cleanup. A 250 ms watchdog identifies an unresolved fixture rather than leaving a blocked syscall or process. Tests use actual Node Writable streams through the supported process adapter; they do not start an OS child or access private manager fields.

Repair `873537248bbe0274d0bd9e94f82a0ebfa1f43a0f` extracts delivery to a narrow stdin adapter. Both write and end callbacks are checked, close rejects unfinished delivery, and successful/error/close paths remove per-call observers. On a failed callback an error observer remains until error or close because Node invokes write/end callbacks before emitting the stream error; this also covers asynchronous destruction without an uncaught Runner error. No payload is automatically retried, Job state is not terminalized by a stdin failure, and accepted byte counts still measure UTF-8 bytes, not proof of child consumption.

The focused post-repair suite passed all eight tests without skips, including two additional cases for delayed destruction and failed backpressured writes. Architecture validation assigns only the input module an explicit adapter role, permits only stream type imports, and rejects concrete storage/process/manager coupling. Four negative architecture fixtures and one positive type-only fixture were added; all 89 architecture tests passed.

## Release evidence and limits

SEC19 is mandatory in the release-readiness contract, references the source repair as an ancestor, and executes job-input.test.ts in the candidate-bound security lane. Evidence regressions reject deleting or relabeling SEC19. The file is also classified in the ordinary Runner inventory and therefore executes in the full Runner/native lanes.

All 26 ordinary gates and real browser E2E must be rerun on the exact clean follow-up candidate. The companion evidence directory records start/end commit and tree, each exit status, source-bound security evidence, and the browser executable actually used. Focused tests, provider status from an earlier commit and local Linux results are not substitutes for native platform, signed artifact, installed-component or production acceptance.

A child that remains alive and never consumes stdin can still apply backpressure; this repair does not promise a new input deadline or prove delivery to the child application. Cancellation/retry policy and operating-system process containment are unchanged. The original workspace is not reset, no named branch is added, no push/main promotion/stable publication is performed, and immutable v0.1.3 assets are untouched.
