# Dev branch protection

The GitHub default branch is `dev`. It is **currently unprotected**: the GitHub branch-protection API returned `404 Branch not protected` during the `v0.1.0-dev.2` final-bugs baseline check. This document records the required configuration and does not claim that it has been applied.

A repository administrator should configure protection for `dev` at **Settings → Rules → Rulesets** (or **Branches → Branch protection rules**) with:

- require a pull request before merging;
- require the `verify` status check to pass;
- require branches to be up to date before merging;
- prohibit force pushes;
- prohibit branch deletion;
- allow an administrator emergency bypass only when documented.

The single-maintainer workflow does **not** require an approving review or Code Owner approval. Do not add either requirement solely for this preview.

Older clones can synchronize the in-place rename without recreating `main`:

```sh
git fetch origin
git branch -m main dev  # only when a local main branch still exists
git branch -u origin/dev dev
git remote set-head origin -a
git remote prune origin
```

Do not create a new `main` branch. After a repository administrator enables the rule, verify it with a test pull request before treating it as active policy.
