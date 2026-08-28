# Contributing to Runmesh

Thank you for helping improve Runmesh. We welcome bug reports, reproductions,
tests, documentation, design discussion, translations, accessibility work, and
code contributions from individuals and organizations.

## Contribution terms

Runmesh is source-available under the
[PolyForm Noncommercial License 1.0.0](../LICENSE). When you submit a pull request,
patch, issue attachment, documentation change, test, design contribution, or
other contribution to the official `aloneio/runmesh` repository, you confirm
that:

- you have the right to submit the contribution and grant the permissions below;
- you retain copyright and attribution in the contribution;
- you grant Runmesh and its maintainers a non-exclusive, worldwide,
  royalty-free, perpetual license to use, reproduce, modify, prepare derivative
  works of, distribute, sublicense, and include the contribution in the
  source-available Runmesh community edition and future commercially licensed
  Runmesh editions;
- where legally applicable, you grant a corresponding patent license for claims
  necessarily infringed by the contribution or its combination with Runmesh; and
- you have resolved any employer, contractor, confidentiality, dependency,
  patent, and third-party licensing obligations that apply to the contribution.

The contribution license applies only to the submitted contribution. It does not
change the PolyForm license for Runmesh itself and does not grant commercial-use
rights to you, your employer, or another organization. Commercial production
use, paid hosting, commercial SaaS, resale, white-label distribution, and
commercial integration require written authorization; see
[COMMERCIAL_LICENSE.md](../docs/legal/COMMERCIAL_LICENSE.md).

If you contribute for an employer or entity, your submission confirms that you
have authority to make the submission and grant these rights. Do not submit
confidential information, credentials, personal data, or material that you do
not have the right to share.

## How to contribute

1. Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Use the
   private security process and do not put credentials, secret URLs, private
   Workspace paths, sensitive logs, or exploit details in a public issue.
2. For a substantial change, open an issue or design discussion first. Explain
   the problem, proposed approach, alternatives, safety and compatibility
   impact, and validation plan. Small fixes, documentation, tests, and clearly
   scoped maintenance may start as a focused pull request.
3. Keep the change focused and update the tests and documentation affected by
   the change.
4. Describe the problem, solution, validation, security impact, and compatibility
   impact in the pull request. The pull-request checklist repeats the key
   contribution confirmations.
5. Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and
   [GOVERNANCE.md](../docs/community/GOVERNANCE.md).

## Development expectations

- Preserve security boundaries. Do not log credentials, secrets, absolute
  Workspace roots, sensitive file content, commands, or process identifiers.
- Keep TypeScript strict. Do not use placeholder security controls, broad
  permissions, unchecked casts, swallowed errors, or unbounded I/O as shortcuts.
- Do not copy code, assets, or trademarks without identifying their source,
  license, required notices, and redistribution impact in the pull request.
- Add focused tests for behavior changes and run generators when changing
  generated artifacts.
- Use clear, reviewable commits and explain any necessary cross-cutting change.
- Keep contributor attribution in Git history and project acknowledgements.

## Getting help

Use the [issue tracker](https://github.com/aloneio/runmesh/issues) for public,
non-sensitive questions. Request a private channel for commercial discussions
or security reports without posting confidential information.

This document is project guidance, not legal advice. Obtain qualified advice for
questions about your rights, obligations, or a planned commercial use.
