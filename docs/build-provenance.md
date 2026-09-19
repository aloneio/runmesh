# Check which Worker source is deployed

Use `/health` to identify the Worker's compiled Git commit and compare it with the commit you intended to deploy. The package version alone is not enough: several commits can share a version. Updating a Worker does not upgrade an installed Runner or publish a signed Runner package.

## Configure the build

In Cloudflare Workers Builds, use the repository root and set the build command to:

```sh
npm run build
```

For production, connect the protected `main` branch and use:

```sh
npm run deploy:worker -- --env production
```

For the separate development Worker, connect `dev` and use:

```sh
npm run deploy:worker -- --env development
```

The current **0.1.4 candidate** is not activated for production. The production wrapper refuses a candidate and preserves the existing deployment. Complete the reviewed release activation before using the production command.

Keep the build command explicit: Cloudflare Workers Builds does not use Wrangler Custom Builds as a replacement for its configured build step. Use the repository's pinned Node/npm versions and avoid `--no-build` or `--no-bundle` shortcuts.

The build records the actual Git commit and source tree. No additional runtime variable or secret is needed. Cloudflare, GitHub and GitLab source declarations must agree with the checkout. Build from a clean checkout; tracked edits, untracked application files, source symlinks, hidden index flags or unverified submodules prevent a clean source declaration. Source archives without Git can be built locally, but cannot provide verified Git provenance for the deployment wrapper.

## Verify a deployment

From the repository, run:

```sh
npm run check:deployment -- https://your-worker.example <expected-full-commit> main
```

Use the actual 40-character commit and replace `main` with `dev` for the development Worker. The checker makes one HTTPS request to `/health` and requires a clean, identified source with the expected commit and branch. It does not change the deployment or retry automatically. The request has a 10-second deadline, including the response body, and a 16 KiB response limit.

A successful response can include:

```json
{
  "deployment": {
    "schema_version": 1,
    "state": "identified",
    "source": "git_build",
    "build_state": "clean",
    "branch": "main",
    "commit": "<actual-40-character-commit>",
    "tree": "<actual-40-character-tree>",
    "agreement": "not_comparable",
    "attestation": "self_reported"
  }
}
```

The hash placeholders above are examples, not valid values. `/health` returns `Cache-Control: no-store`.

| Result | Meaning and next step |
| --- | --- |
| `state=identified`, expected commit and branch | The Worker reports the intended compiled source |
| `agreement=matched` | Recognized Cloudflare version metadata agrees with the compiled source |
| `agreement=not_comparable` | No recognized provider tag is available for comparison; the compiled source can still be identified |
| `state=conflict` | Provider metadata disagrees; inspect the build and deployment before accepting the result |
| Missing or unconfirmed source | Check the build command, Git checkout and logs; do not substitute a manually entered commit |

A version-only response from an older Worker fails this provenance check, but does not by itself prove the Worker is unavailable. Likewise, `ok=true` means the health handler responded; verify login, Runner connectivity and the required MCP operations separately.

## When a build fails

If Cloudflare fails while installing tools or dependencies, the Worker upload has not started. Check the full build log, the configured toolchain and cache settings before retrying. That error alone does not identify a bad Node release, corrupted cache or application defect. After a successful retry, compare the live commit with the intended commit using the command above.

A deployment preflight failure occurs before Wrangler uploads anything. An uploader failure may leave the provider outcome uncertain; check the deployed source before retrying.

## Deployment and trust boundaries

For the maintained development setup, a separately configured host bridge can fast-forward GitLab `dev` only after GitHub `verify-all` succeeds for the exact current SHA. The connected Cloudflare Worker then builds that GitLab push. The repository does not install this bridge, a scheduler or a provider connection for you. See [deployment](deployment.md).

The source statement is `self_reported`, not a digital signature or a reproducible-build proof. It depends on the build host and its Git metadata. Dependencies, ignored generated inputs and environment-dependent transforms are outside the tracked source-tree identity. Do not change source while it is bundling. Signed Runner releases, Worker source commits, Cloudflare version IDs and installed Runner versions must be checked separately.

References: [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [default Git metadata variables](https://developers.cloudflare.com/changelog/post/2025-06-10-default-env-vars/), [version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/).
