# Main promotion policy

Normal development enters `dev`. Production changes enter `main` only through
an explicit pull/merge request whose source is **the same repository's `dev`**.
A fork branch named `dev`, `feature/*`, `fix/*`, tags and direct pushes are not
alternative production paths. This policy does not authorize a production
deployment or merge the current development backlog automatically.

## Two independent controls

Server-side branch protection rejects direct changes: GitHub requires a PR,
applies the rule to administrators, requires `verify-all` plus the unique
`main-source-policy` check from GitHub Actions, and forbids force pushes and
deletion. GitLab sets **Allowed to push and merge: No one**, preserves the
existing maintainer merge role, and requires successful, non-skipped pipelines.
Keep conversation resolution and existing verification requirements enabled.
An Action on `push` runs after the ref changed; it is not a push prohibition.

The source check is metadata-only, has no checkout/install/deployment step,
and never receives a signing key. It compares project/repository identities
as well as exact `main`/`dev` names. GitHub listens to opening, reopening,
synchronization, target edits and ready-for-review events; its job is not
conditionally skipped for a wrong source. A missing required check blocks
merging rather than silently succeeding. Ordinary `dev` CI must never produce
the `main-source-policy` GitHub check, because checks belong to commit SHAs.

## GitLab trusted entrypoint

In this repository's project setting **CI/CD configuration file**, select:

```text
.gitlab/main-policy.yml@aloneio/runmesh:dev
```

The root entrypoint is read from reviewed `dev`, including for source branches
which predate the gate. It includes the ordinary `.gitlab-ci.yml` at the actual
pipeline commit and then overlays the mandatory metadata-only `.pre` job and
pipeline creation rules. Thus an old branch with otherwise passing tests cannot
omit the source gate. No new secret, Runner variable or cloud resource is needed.
Other repository owners substitute their own project path in this administrative
setting. Review changes to the trusted entrypoint as security configuration.

Do not override predefined CI provenance variables. After retargeting a GitLab
MR, run a new MR pipeline for its current target before merging; historical
pipeline success is not evidence about a different target. The repository
administrator remains responsible for configuration and merge permissions.

## Generated and tested configuration

`scripts/main-promotion-policy.mjs` owns the metadata predicates. The generator
embeds the same dependency-free function bodies in GitHub and GitLab jobs:

```sh
node scripts/check-main-policy.mjs --write
npm run check:promotion-policy
node --test test/main-promotion-policy.test.mjs
```

`check:promotion-policy` verifies rather than rewrites workflow files in CI.
Keep it in both CI systems and classify new tests in the verification manifest.
Neither generated files nor local hooks prove remote settings are enabled;
verify the actual provider APIs and positive/negative draft PR/MR checks.

## Release and enforcement boundaries

Create `dev -> main` only for an explicitly approved promotion, wait for source
policy and all normal checks, then merge using the provider PR/MR endpoint or UI.
Do not use `git push ...:main`, even to fast-forward an approved commit, and do
not temporarily weaken protection to publish. Mirror promotion through the
corresponding `dev -> main` MR; reconcile merge strategy/commit identity without
force pushes. Existing stable release gates still require protected `main`.

The GitHub job is deliberately a read-only `pull_request` workflow: it can
bootstrap from `dev` without modifying/deploying the current `main`. Repository
editors who deliberately replace the workflow can falsify source-controlled CI;
this is not an immutable organization-level policy or a defense against an
administrator changing repository settings. A future trusted-default-branch
workflow or separately administered required workflow can harden that threat
model, but must not be silently installed by releasing unapproved code.

Do not claim a `git push --dry-run` exercised remote pre-receive checks. Testing
the main ref itself could accidentally deploy if protection were misconfigured;
prefer API verification and disposable protected test branches. Draft promotion
probes must be closed, never merged, and must leave `main` unchanged.
