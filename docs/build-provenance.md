# Worker build provenance

R01 / R09 development slice based on `88b119782d26316d68eeaa98a47d71dbe4382193`. This identifies Worker source; it does not upgrade an installed Runner, activate production or replace immutable release signatures.

## Why version alone was insufficient

Several development changes shared product version 0.1.3. The previous health implementation could identify source only when a `main:<commit>` or `dev:<commit>` provider tag was present. A successful untagged deployment returned null source fields, even when its build checkout was known. Health also lacked an explicit no-store response header.

The build now generates `apps/worker/src/generated-provenance.ts` from the actual local Git checkout. This file is deliberately ignored: committing a file containing its own commit hash would make the statement stale immediately. Generated values are deterministic and contain no author email, hostname, absolute path, build secrets or arbitrary branch labels. The module is replaced with an unavailable statement before a strict failed generation can leave an earlier identity behind.

## Supported build paths

The root `npm run build`, typecheck/version generation, Worker workspace build/test/typecheck, explicit deployment wrapper and local Wrangler custom build all prepare the module. Do not use `--no-bundle` or `--no-build` as a supported release shortcut.

For Workers Builds configure repository-root build `npm run build` and deploy `npm run deploy:worker -- --env production` from main, or `--env development` from dev in the separate development Worker. Workers Builds documentation states that it does not honor Wrangler Custom Builds as its build configuration; the root build command therefore remains explicit rather than relying on the local Wrangler hook alone.

No new runtime variable or secret is required. Workers Builds already supplies its source commit and branch to the build process; they are not automatically runtime bindings. The generator checks those values against Git. GitHub and GitLab commit declarations are also cross-checked. Conflicting, malformed or wrong SHA values cannot replace the checkout's identity. Pull-request, merge-request and tag contexts never inherit a target main/dev branch label.

The local generator reads bounded Git output, disables optional index writes, replace refs, external diff and fsmonitor, and performs no network requests. Untracked application files and tracked/staged edits are dirty. Assume-unchanged, skip-worktree, source symlinks and unverified submodules prevent a clean statement. Source archives without Git remain buildable with unavailable provenance outside strict deployment mode; an environment string alone cannot manufacture a commit. The existing deployment wrapper refuses these states before invoking Wrangler, while preserving main/dev branch and reviewed-release checks.

## Public health

`/health` now returns `Cache-Control: no-store`. Its existing `deployment.branch` and `deployment.commit` fields are retained, with additive provenance fields:

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

The example placeholders are explanatory, not valid deployed hashes. A clean compiled source is sufficient when a provider tag is absent or unrecognized. Recognized matching provider metadata gives `agreement=matched`; a different commit or incompatible branch gives `state=conflict` and null top-level source fields. Provider version ID and creation time are projected separately, with only validated values. Raw unrecognized tags are not returned. A plausible provider tag cannot turn a dirty, invalid or missing build into clean source. Legacy manually injected source variables are not treated as proof of compiled source.

The projection is pure and does not access Registry, Runner DO, D1, Git, a filesystem, a network endpoint or a timer at request time. Its report remains under a tested 1 KiB bound. Metadata disagreement affects diagnostic truthfulness; it does not revoke credentials or interrupt unrelated authorized work. `ok=true` still means the health handler responded, not that every downstream dependency or all provenance checks passed.

## Explicit post-deployment observation

```sh
npm run check:deployment -- https://your-worker.example <expected-full-commit> main
```

Use the actual expected 40-character commit. The observer performs one HTTPS health read, rejects redirects and secret-bearing URLs, explicitly omits browser credentials, and requires identified clean source with the expected commit and branch. Response handling has a 16 KiB byte limit, at most 256 stream reads, and a 10-second deadline covering the response body. Failed, oversized, excessively fragmented or aborted responses are cancelled; invalid UTF-8 is rejected rather than silently replaced. It does not redeploy, retry, poll, read account tokens or print a raw failure response. An old version-only health response is a failed provenance check, not proof of a failed Worker.

Deployment preflight failures print a fixed error and recovery categories, not an assertion stack, local path or raw branch metadata. This pre-upload failure is distinct from an uploader failure with an uncertain provider outcome. Neither path automatically retries a deployment.

## Trust and rollout boundary

This is a self-reported build-source statement, not a cryptographic attestation or a reproducible binary proof. The trusted build host and Git metadata can be modified by their operator. Dependencies, ignored generated inputs, build tool versions and environment-dependent transforms are outside the tracked source tree identity. A malicious or concurrently modified build host is not made trustworthy by this feature. Do not mutate source while bundling.

The signed Runner version, actual Worker source, provider version ID and actual client's tool catalog remain separate facts. These changes must still pass same-SHA CI and be explicitly promoted to main before production deployment can be observed. There is no account-level Cloudflare log access or new account telemetry collector in this slice.

Primary references: [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [default Git metadata variables](https://developers.cloudflare.com/changelog/post/2025-06-10-default-env-vars/), [version metadata binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/).
