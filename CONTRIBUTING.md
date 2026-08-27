# Contributing to Runmesh

Thank you for helping improve Runmesh. We welcome bug reports, reproductions,
tests, documentation, design discussion, translations, accessibility work, and
code contributions from individuals and organizations.

Runmesh is a source-available noncommercial community edition under the
[PolyForm Noncommercial License 1.0.0](LICENSE). The project also grants a
narrow [contribution-development permission](CONTRIBUTION_PERMISSION.md) for
copying, running, modifying, and testing Runmesh when preparing an upstream
contribution. That permission does not authorize commercial production use.

## Start here

1. Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Do not put
   credentials, secret URLs, private Workspace paths, sensitive logs, or exploit
   details in a public issue.
2. For a substantial change, open an issue first with the problem, proposed
   approach, alternatives, safety/compatibility impact, and validation plan.
   Small fixes and documentation improvements may start as a focused pull
   request.
3. Keep the change scoped and update tests and documentation that the change
   affects.
4. Run the relevant checks. At a minimum, record the commands you ran and any
   check you could not run locally.
5. Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and the pull-request template.

## Contributor agreement and rights

You keep copyright in your contribution and may use your own code in other
projects. Runmesh uses a license grant, not copyright assignment, so accepted
contributions can be included in the current community edition and in future
commercially licensed Runmesh editions.

Before a **substantive code contribution** is merged, complete the applicable
[Individual CLA](CLA-INDIVIDUAL.md) or [Entity CLA](CLA-ENTITY.md). See
[docs/cla-setup.md](docs/cla-setup.md) for the current signing and recordkeeping
process. The project does not claim that CLA automation is enabled unless that
setup document is updated with evidence.

Only submit material that you have the right to contribute. If you are employed,
contracted, or contributing on behalf of an entity, confirm employer ownership,
open-source policy, confidentiality, and patent obligations before submission.
An Entity CLA is appropriate when the entity authorizes contributions. A
contribution does not grant you or your employer commercial production-use
rights; see [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md).

## Development expectations

- Preserve security boundaries and avoid logging credentials, secrets, absolute
  Workspace roots, sensitive file content, commands, or process identifiers.
- Keep TypeScript strict. Do not use placeholder security controls, broad
  permissions, unchecked casts, swallowed errors, or unbounded I/O as a shortcut.
- Do not copy code, assets, or trademarks without identifying their source,
  license, required notices, and redistribution impact in the pull request.
- Add focused tests for behavior changes and avoid changing generated artifacts
  without running their generator.
- Use clear, reviewable commits. Do not mix unrelated runtime, legal, release,
  or documentation changes without explaining why.

## Pull requests

Describe the problem, solution, tests, documentation changes, security impact,
and compatibility impact. Complete the PR checklist, including CLA status where
required. Maintainers review changes under [GOVERNANCE.md](GOVERNANCE.md); a
merge decision does not waive license, contributor-agreement, or security
requirements.

## Getting help

Use the [issue tracker](https://github.com/aloneio/runmesh/issues) for public,
non-sensitive questions. Request a private channel for commercial discussions
or security reports without posting confidential information.
