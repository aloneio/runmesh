# Main branch protection

The repository workflow cannot configure GitHub branch protection without repository-administration permission. An administrator should configure protection for `main` at **Settings → Rules → Rulesets** (or Branches → Branch protection rules) with:

- Require a pull request before merging.
- Require at least one approving review.
- Dismiss stale approvals when new commits are pushed.
- Require status checks to pass before merging, including the `CI / verify` check.
- Require branches to be up to date before merging.
- Block force pushes.
- Block branch deletion.
- Restrict direct pushes to administrators or an explicit release role.

Verify the rule with a test pull request before treating it as production policy. This document records the required operator action; no branch protection claim is made by the code repository itself.
