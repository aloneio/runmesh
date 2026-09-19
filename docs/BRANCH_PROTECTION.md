# Branch and release protection

Repository administrators configure branch rules and release environments; CI checks the source that passes through them. Normal development uses `dev`, and stable publication uses protected `main`.

## Required controls

- Require `verify-all` for the exact candidate SHA. It aggregates `verify`, native Runner checks, the supported Node LTS matrix and browser checks; failed, cancelled or skipped dependencies fail the aggregate.
- Apply the [main promotion policy](main-promotion-policy.md), including its required source check and provider-specific PR/MR protections.
- Protect version tags, enable immutable releases, and protect the stable `release` environment.
- Retain owner-only publication checks for both the original actor and any rerun actor.

## Verify the live configuration

Use administration-read access to inspect the actual branch rules, required checks, tag protection and environment approvals on each provider. Save the responses alongside the candidate's CI results. Resolve denied or incomplete reads before marking a control verified.

Check the GitLab synchronization setup and Cloudflare build connection separately. Confirm which repository, branch and commit the Worker build uses, then verify the deployed source. See [build provenance](build-provenance.md).

Before publication, resolve failed platform checks and verify the candidate's signed assets. Keep previously published assets immutable throughout recovery.
