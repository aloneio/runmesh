# Check which Worker source is deployed

[简体中文](build-provenance.zh-CN.md)

Compare the Git commit reported by `/health` with the commit you intended to deploy. This identifies the source even when several commits share one package version. Check the installed Runner version separately during an upgrade.

## Configure the build

In Cloudflare Workers Builds, select the repository root and set:

```sh
npm run build
```

Use the repository's pinned Node/npm versions and keep both the build and bundling steps enabled. Workers Builds needs this explicit build command in its settings.

Connect `dev` to the separate development Worker:

```sh
npm run deploy:worker -- --env development
```

For production, use protected `main` after its signed release has been verified and activated:

```sh
npm run deploy:worker -- --env production
```

Current source is the **0.1.4 candidate**. Complete release activation before using the production command; candidate testing uses development.

Build from a clean Git checkout and keep it unchanged until bundling finishes. The build checks the actual commit and tree against Cloudflare, GitHub and GitLab declarations. Tracked edits, untracked application files, source symlinks, hidden index flags or unverified submodules prevent a clean source declaration. Use a Git checkout, rather than a source-only archive, for a deployment that needs verified source identity.

## Verify a deployment

From the repository, run:

```sh
npm run check:deployment -- https://your-worker.example <expected-full-commit> main
```

Supply the actual 40-character commit; use `dev` as the last argument for development. The checker sends one HTTPS request to `/health` and requires clean, identified source with the expected commit and branch. It is read-only, with a 10-second deadline covering headers and body and a 16 KiB response limit.

| Result | Meaning and next step |
| --- | --- |
| `state=identified`, expected commit and branch | The Worker reports the intended compiled source |
| `agreement=matched` | Recognized Cloudflare version metadata agrees with that source |
| `agreement=not_comparable` | No recognized provider tag is available; check the compiled `state`, commit and branch |
| `state=conflict` | Inspect the build and deployment to resolve conflicting source declarations |
| Missing or unconfirmed source | Check the build command, Git checkout and logs |

Health responses use `Cache-Control: no-store`. Older Workers may provide only a product version; update through the reviewed deployment path to obtain commit-level identification.

After the source check, verify administrator login, Runner connection and policy acknowledgement, then the MCP operations needed for your workload. Follow the [upgrade guide](upgrading.md) for that sequence.

## Resolve a failed build or upload

| Failure stage | Next step |
| --- | --- |
| Cloudflare tool or dependency installation | Inspect the full log, configured toolchain and cache settings, then retry after correcting the reported problem |
| Deployment preflight | Correct the branch, source or release-state issue before starting an upload |
| Wrangler upload | Inspect the live source first; the provider may have accepted the deployment despite a failed response |

After any successful retry, run the source comparison above.

## Provider setup and source records

In the maintained development setup, a separately configured host bridge fast-forwards GitLab `dev` after GitHub `verify-all` passes for the exact SHA. The connected Cloudflare Worker builds that GitLab push. Configure these connections for your own deployment as described in [deployment](deployment.md).

The health record uses `attestation=self_reported`: it reports tracked Git source from the build host. Keep that host and its Git metadata trusted. Record dependency and build-environment verification with CI, and Runner signature verification with the release evidence. Retain the Worker commit, Cloudflare version ID and installed Runner version together when recording an upgrade.

References: [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [Git metadata variables](https://developers.cloudflare.com/changelog/post/2025-06-10-default-env-vars/), [version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/).
