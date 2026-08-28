# Dev branch protection

The GitHub default branch is `dev`. Its branch-protection configuration was confirmed through the GitHub branch-protection API during the `v0.1.0-dev.2` baseline check:

- `dev` is protected;
- the required status check is `verify` and it is strict, so a branch must be up to date before merging;
- the required approving-review count is `0`;
- force pushes are disabled; and
- branch deletion is disabled.

The API response also reports that Code Owner review is not required and administrator enforcement is disabled. This document does not infer any additional ruleset, bypass, merge-queue, or repository setting from that response.

Older clones can synchronize the in-place rename without recreating `main`:

```sh
git fetch origin
git branch -m main dev  # only when a local main branch still exists
git branch -u origin/dev dev
git remote set-head origin -a
git remote prune origin
```

Do not create a new `main` branch. Re-query the GitHub branch-protection API after any administrative configuration change before relying on a changed protection policy.
