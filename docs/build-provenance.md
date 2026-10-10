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

For production, deploy a tested `main` commit that includes the stable release activation listed in [release status](release-readiness.md). Later control-plane updates can retain that same Runner release. Test upcoming changes with development, then verify the deployed source using the checks below.

Build from a clean Git checkout and keep it unchanged until bundling finishes. Commit application changes before deployment and check that submodules are at their recorded revisions. The build compares this source with the commit reported by Cloudflare, GitHub or GitLab. A fresh checkout of the intended commit provides a straightforward starting point when resolving a source mismatch.

## Verify a deployment

From the repository, run:

```sh
npm run check:deployment -- https://your-worker.example <expected-full-commit> main
```

Supply the actual 40-character commit; use `dev` as the last argument for development. The first argument must be the exact HTTPS origin, such as `https://your-worker.example`, without a trailing slash, path, query or credentials. The checker reads `/health` once and confirms that the compiled source has the expected commit and branch. If the request times out, check Worker availability before running it again.

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

For a GitLab mirror, configure synchronization and the Cloudflare build connection as described in [deployment](deployment.md). Record the commit selected by that deployment, then compare it with the live Worker using the command above.

The health field `attestation=self_reported` means the build host recorded the Git source. Use a trusted build environment and retain its CI results. Keep the Worker commit, Cloudflare version ID and installed Runner version together in your upgrade record; verify the Runner package signature during installation.

References: [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [Git metadata variables](https://developers.cloudflare.com/changelog/post/2025-06-10-default-env-vars/), [version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/).
