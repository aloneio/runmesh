# Branch and release protection

The repository's development branch is `dev`. Publication requires the owner and runs the complete CI workflow at the triggering SHA before signing/publishing can start. The reusable workflow requires `verify`, native Runner checks, the supported Node LTS matrix and browser checks; `verify-all` fails for failed, cancelled or skipped dependencies.

Repository administrators must configure `verify-all` as a required status check, protect version tags and enable immutable releases, and protect the `release` environment. Owner-only publication also checks both original and rerun actors. Source configuration is not evidence of the live repository's rules, environment approvals, GitLab mirror or Cloudflare deployment state. Verify these independently with administration-read permission and save the results before release. A denied API request is not a successful check.

Keep published assets immutable, resolve failed platform jobs and require checks for the exact candidate SHA. Cloudflare Workers Builds must deploy the approved SHA; verify its provider-side settings and completion record separately.
