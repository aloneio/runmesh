# Branch and release protection

The repository's development branch is `dev`. Current source requires the owner for publication and calls the complete CI workflow at the triggering SHA before the signing/publishing job can start. The reusable workflow requires `verify`, all native Runner checks, and the supported Node LTS matrix; `verify-all` fails for failed, cancelled or skipped dependencies.

Repository administrators must configure `verify-all` as a required status check, protect version tags and enable immutable releases, and protect the `release` environment. Owner-only publication also checks both original and rerun actors. Source configuration is not evidence of the live repository's rules, environment approvals, GitLab mirror or Cloudflare deployment state. Verify these independently with administration-read permission and save the results before release. A denied API request is not a successful check.

Never bypass a failed platform job, reuse dev.5 assets, or treat the pre-fix SHA's green checks as approval of new code. Cloudflare Workers Builds must only deploy the approved SHA; its provider-side settings and completion record require separate owner verification.
