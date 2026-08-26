# Dev branch protection

The GitHub default branch is `dev`. The repository cannot configure branch protection without repository-administration permission. An administrator should configure protection for `dev` at **Settings → Rules → Rulesets** (or Branches → Branch protection rules) with:

- require a pull request before merging;
- require at least one approving review;
- require the `CI / verify` status check to pass;
- require branches to be up to date before merging;
- prohibit force pushes;
- prohibit branch deletion;
- allow an administrator emergency bypass only when documented.

Older clones can synchronize the in-place rename without recreating `main`:

```sh
git fetch origin
git branch -m main dev  # only when a local main branch still exists
git branch -u origin/dev dev
git remote set-head origin -a
git remote prune origin
```

Do not create a new `main` branch. Verify the rule with a test pull request before treating it as active policy. This file records required operator action and does not claim that protection is configured.
