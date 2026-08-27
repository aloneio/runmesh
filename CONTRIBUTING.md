# Contributing to Runmesh

Thank you for helping improve Runmesh. We welcome bug reports, reproductions,
tests, documentation, design discussion, translations, accessibility work, and
code contributions from individuals and organizations.

Runmesh is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE). By submitting a contribution to
the official `aloneio/runmesh` repository, you confirm that:

- you have the right to submit the contribution;
- you grant Runmesh and its maintainers a non-exclusive, worldwide,
  royalty-free, perpetual license to use, modify, distribute, sublicense, and
  include the contribution in Runmesh community and commercially licensed
  editions; and
- you retain copyright and attribution in your contribution.

This deemed-acceptance contribution term replaces a separate signature or CLA
submission for ordinary contributions. You do not need to email, upload, or
sign a separate agreement. Submission of a pull request, patch, issue
attachment, or other contribution is treated as acceptance of these terms for
that contribution.

This contribution permission does not grant commercial-use rights to you, your
employer, or any other organization. Commercial use still requires separate
written authorization; see [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md).

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

## Contributor rights and authority

You keep copyright in your contribution and may reuse your own work elsewhere.
Only submit material that you have the right to contribute. If you are employed,
contracted, or contributing on behalf of an entity, confirm employer ownership,
confidentiality, open-source-policy, and patent obligations before submission.
Submitting on behalf of an employer or entity means that you confirm you have
permission to grant the contribution license described above.

The contribution license is limited to rights in the submitted contribution and
does not authorize production deployment, internal business operations, paid
hosting, commercial SaaS, resale, white-label distribution, or commercial
integration of Runmesh. The project does not claim that this document has been
reviewed by a lawyer.

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
and compatibility impact. The pull-request template includes a simple
contribution-terms confirmation. It is a reminder, not a request for a separate
signature or private record.

Maintainers review changes under [GOVERNANCE.md](GOVERNANCE.md). A merge
decision does not waive the license, security, or authority confirmations above.
Maintainers may ask for clarification or decline a contribution when ownership,
confidentiality, patent, or licensing authority is unclear.

## Getting help

Use the [issue tracker](https://github.com/aloneio/runmesh/issues) for public,
non-sensitive questions. Request a private channel for commercial discussions
or security reports without posting confidential information.
