# Main promotion policy

Develop on `dev` and promote production changes through an explicitly approved
PR/MR from **the same repository's `dev` to `main`**. The source check validates
both repository identity and branch names.

## Configure provider protection

On GitHub, require a PR and apply the rule to administrators. Require
`verify-all` and the unique `main-source-policy` check from GitHub Actions,
with force pushes and deletion disabled. Retain conversation resolution and
the existing verification requirements.

On GitLab, set **Allowed to push and merge: No one**, retain the maintainer merge
role, and require a successful, non-skipped pipeline. Provider branch rules
control ref updates; the source-policy job checks whether a proposed PR/MR has
the approved origin.

The source-policy job reads platform event metadata. GitHub runs it for opening,
reopening, synchronization, target edits and ready-for-review events. A wrong
source produces failure, and a missing required check blocks merging. Keep
`main-source-policy` exclusive to this workflow: checks belong to commit SHAs,
so ordinary `dev` CI must use its own names.

## GitLab trusted entrypoint

Set the project's **CI/CD configuration file** to:

```text
.gitlab/main-policy.yml@aloneio/runmesh:dev
```

This loads the entrypoint from reviewed `dev`, includes ordinary
`.gitlab-ci.yml` at the actual pipeline commit, then applies the mandatory
metadata-only `.pre` job and pipeline creation rules. Source branches that
predate the gate receive the same policy. For a fork, substitute its project path
in this administrative setting.

Review changes to the trusted entrypoint as security configuration and preserve
predefined CI provenance variables. After retargeting an MR, run a new MR
pipeline against its current target before merging.

## Maintain the policy

`scripts/main-promotion-policy.mjs` owns the metadata predicates. The generator
embeds the same dependency-free functions in GitHub and GitLab jobs. After
changing a rule, generate and review the configuration, then check it:

```sh
node scripts/check-main-policy.mjs --write
npm run check:promotion-policy
node --test test/main-promotion-policy.test.mjs
```

CI uses `check:promotion-policy` to verify the generated files. Keep that check
in both systems and register new tests in the verification manifest.

Verify live branch rules through the provider APIs. Exercise valid dev sources,
invalid sources and same-named fork branches with draft PR/MR probes; close the
probes after checking their results. Test ref-update protection with disposable
protected branches. `git push --dry-run` does not execute remote pre-receive
checks.

## Promote a release

For an approved promotion, open `dev -> main`, wait for the source policy and
all required checks, then complete the protected PR/MR promotion.

On GitHub, verify that the passing `dev -> main` PR is mergeable and its head
and base match the current remote branches. Confirm that `main` is an ancestor
of the reviewed `dev` commit, then push that exact commit normally to protected
`main` as a fast-forward. The branch rules remain enabled and enforce the PR
checks. Verify that GitHub marks the PR as merged and that `main` points to the
reviewed head. This uses GitHub's supported
[local merge workflow](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
and preserves the existing author and committer identity,
`aloneio <git@aloneio.aleeas.com>`.

Use the corresponding protected GitLab `dev -> main` MR with the fast-forward
merge method and a successful pipeline. Preserve `dev` and verify that both
providers' `main` branches point to the same reviewed commit.

Stable publication continues from protected `main` through its release gates.
Verify the final commit on both providers and the deployed Worker separately.

The current GitHub policy uses a read-only `pull_request` workflow. Its trust
boundary includes maintainers who can change workflow files or repository rules.
Review those changes as security-sensitive configuration; organizations that need
independent enforcement can use a separately administered required workflow.
