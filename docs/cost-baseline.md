# Runmesh cost baseline

This baseline defines the measurements used before enabling a hosted Worker deployment. It deliberately records observed usage instead of embedding provider prices that change independently of the code.

## Measurements

Record a UTC window and combine available counters from Cloudflare analytics and host monitoring:

- Worker requests, Durable Object requests, and WebSocket connection minutes.
- Durable Object storage reads/writes and SQLite row counts.
- Authentication attempts, MCP calls by method, and bridge calls by outcome.
- Runner job count, wall time, output bytes, and retained log bytes.

For each counter, record `window_start`, `window_end`, `environment`, `git_sha`, `sample_count`, and `source`. Keep the raw provider export with the release evidence for the same SHA.

## Derived rates

Compute request/storage rates per active MCP call and CPU/log rates per Job:

- `bridge_calls_per_mcp_call`
- `worker_requests_per_mcp_call`
- `storage_writes_per_mcp_call`
- `runner_cpu_seconds_per_job`
- `runner_log_bytes_per_job`

Use p50, p95, and maximum values. A retry is counted separately from the original call so retry storms remain visible.

## Operator acceptance policy

Before a hosted rollout, collect a seven-day development window and set a quota threshold for each provider resource you rely on. Record unavailable counters as unknown. Compare subsequent windows using the same measurement definitions and record each deployment's SHA. Assign an operator to collect the exports and review the thresholds alongside the CI and deployment results.

## Heartbeat persistence regression budget

The healthy Worker persistence interval is 120 seconds; it coalesces legacy Runner inputs that arrive every 30 seconds. Over a simulated 24-hour steady-state window this means 720 persistence requests per Runner, or 4,320 for six Runners instead of 17,280. That is a 75% reduction in heartbeat persistence requests, not a claim that total account storage cost falls by the same percentage. Reconnects, schema/index maintenance, authorization, active Jobs and other features have separate costs.

`apps/worker/test/heartbeat-budget.test.ts` executes the six-Runner scenario against the local Durable Object SQLite implementation and records `input_frames`, `persistence_requests`, `rows_read` and `rows_written`. It excludes initialization and checks that the heartbeat lane does not add Job, MCP-audit or nonce history. `apps/worker/test/heartbeat-persistence.test.ts` separately exercises a continuous dependency outage, hibernation, successful recovery, explicit identity rejection and the absence of authorization grants from retry metadata.

Treat request counts and SQLite row counts as different measurements: an indexed update can write more than one row. Preserve the emitted counters and test revision, then compare them with a real Cloudflare usage export after a development rollout. Keep the host/transport reconnect rate, unknown audit receipts, deferred history and failed authorization checks visible alongside storage reductions.
