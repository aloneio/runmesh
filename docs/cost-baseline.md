# Runmesh cost baseline

This baseline defines the measurements used before enabling a hosted Worker deployment. It deliberately records observed usage instead of embedding provider prices that change independently of the code.

## Measurements

Record a UTC window and collect the following counters from the deployment dashboard and Runner supervisor:

- Worker requests, Durable Object requests, and WebSocket connection minutes.
- Durable Object storage reads/writes and SQLite row counts.
- Authentication attempts, MCP calls by method, and bridge calls by outcome.
- Runner job count, wall time, output bytes, and retained log bytes.

For each counter, record `window_start`, `window_end`, `environment`, `git_sha`, `sample_count`, and `source`. Keep the raw provider export with the release evidence for the same SHA.

## Derived rates

Compute per active MCP call:

- `bridge_calls_per_mcp_call`
- `worker_requests_per_mcp_call`
- `storage_writes_per_mcp_call`
- `runner_cpu_seconds_per_job`
- `runner_log_bytes_per_job`

Use p50, p95, and maximum values. A retry is counted separately from the original call so retry storms remain visible.

## Release gate

Do not enable a hosted rollout until a seven day development window has a complete export, no unbounded counter, and an operator supplied quota threshold for every provider resource. Compare the next window against the same fields and SHA. A missing provider export is an unknown measurement, not a zero.
