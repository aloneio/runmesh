# Release-chain acceptance

This change closes missing final authorization mappings for diagnostics, patch preview and all Context operations. Protocol-wide mapping parity and real Worker/Runner tests prevent a catalog-only success from hiding unusable tools.

The release workflow tests the exact portable tarball before signing and refuses to create its tag until the audited public Worker health contract is deployed. This health check proves the declared deployment contract and binding presence, not account-wide resource usage; a successful authenticated audit receipt additionally confirms the active audit path. Package E2E is isolated and never restarts the maintained Runner.

## Measured synthetic daily budgets

- 288 scheduled opportunities with unchanged acknowledged Job state: zero additional uploads. Off mode creates no archive sync timer and performs no local snapshot collection.
- 2,880 required 30-second heartbeat updates: 2,880 DO SQL rows read and 2,880 written. These preserve current liveness, not optional history.
- 96 cold empty Job-cleanup turns after schema/cursor initialization: 1,440 D1 rows read and zero written in the local test fixture. This is bounded expiry maintenance, not a full history scan.
- Existing packed snapshot update: 1 Job or 100 Jobs both write one D1 row, as covered by packed-job-history tests.

These component measurements exclude initial schema creation, authentication, deployment, other clients, provider operations not exposed by the test counters, and active workloads. They do not claim zero total Cloudflare consumption or guarantee account-wide free-plan capacity. Required authentication and liveness are never bypassed to produce a zero metric.

The published v0.1.1 assets must remain immutable. A new Runner release requires a new version, exact-commit CI, exact-archive E2E, manifest/signature/checksum verification, published-asset re-download, and an independent immutable-release check. Enable its hosted installer only after those checks, then synchronize GitLab dev and verify the deployed installer contract.
