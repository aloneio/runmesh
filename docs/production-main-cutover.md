# Existing production Worker: GitLab main cutover

## Scope

Promote the verified, published v0.1.2 production source into protected main before changing the Cloudflare source branch. Old main predates the quota fixes and uses an incompatible deployment layout. Do not deploy that old tip. Preserve the existing Worker named runmesh, its domain, D1 history binding, Durable Object namespace and secrets. The unfinished v0.1.3 worktree is not part of this promotion.

The v0.1.2 signed archive keeps its original immutable provenance; moving the serving Worker to main does not republish or relabel the archive. All subsequent formal publication requires the exact protected main tip and the main-restricted release environment. Reusing a published release identifier remains forbidden.

## Cloudflare settings for the existing Worker

In Workers & Pages, select runmesh, then Settings > Builds > Branch control. Keep the existing GitLab repository aloneio/runmesh. Set the production branch to main and disable builds for non-production branches for this Worker. Do not disconnect the repository or create a replacement production Worker.

Set root directory to the repository root, build command to `npm run build`, and deploy command to `npm run deploy:worker -- --env production`. The package script runs checked-in Wrangler with explicit config/environment and source checks. Existing build authorization and runtime secrets must remain configured; do not paste tokens into Git.

Cloudflare's default branch binding is an account-side setting. A Git default-branch change or a successful CI run does not prove that the dashboard setting has changed. Cloudflare documents that Workers Builds does not honor Wrangler Custom Builds settings: the explicitly configured deploy command is the operative guard, not a claim that arbitrary bare Wrangler commands cannot deploy.

After saving, trigger a build for main and confirm its commit matches GitLab main. Do not retry an old dev build to prove main deployment. Check build logs, public health deployment branch/commit, version 0.1.2, and fixed release distributability. Finally validate an authenticated read/exec canary while preserving existing Runner processes.

## Separate development Worker

The separate development Worker now targets `runmeshdev` with `npm run deploy:worker -- --env development`. Its Workers Builds production branch should be `dev` (the primary branch of this development Worker, not the production service). The wrapper rejects a conflicting `WRANGLER_CI_OVERRIDE_NAME`. Keep the account, credentials and state isolated; source validation does not prove the dashboard trigger has been updated.

## Verification

CI covers main/dev pushes and PR/MR checks. The explicit wrapper rejects wrong branches, tags, PRs, conflicting branch metadata and dirty tracked checkouts. Production requires an activated release identity, while published historical provenance remains unchanged. Public health only reports a supplied branch/SHA, or null when the old deploy command did not supply them. It never guesses the deployed SHA from a version number.

Sources: [Branch control](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/), [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [Separate environments](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/).
