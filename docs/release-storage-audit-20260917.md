# Runner storage boundary audit - 2026-09-17

> Historical reference: the results, settings and actions below apply to the stated version or review period. For current use, follow the [documentation index](README.md), [upgrade guide](upgrading.md) and [release status](release-readiness.md).

## Scope and source

This audit continues the [final admission review](release-admission-audit-20260917.md) from dev `4a3d2a461c6400603c781d6f720fa66b02fcbf35`, using an isolated detached worktree on oci0. The original checkout and its uncommitted changes remain untouched. Installation and verification run as the repository owner with a separate npm cache; the existing shared cache has root-owned entries. No production deployment, installed Runner restart, main promotion, stable publication or old-file deletion is part of this audit.

## SEC17: special-file open boundaries

A patch baseline could open an existing FIFO and wait indefinitely for a peer before reaching its descriptor validation. Context and Job metadata readers could likewise block when a regular file was replaced by a FIFO between the path check and open. Job log reads/appends additionally lacked a post-open regular-file and path-identity check.

Source repair `31fdac268382992ebf5507e185ba623018c75588` rejects existing non-regular patch targets, adds nonblocking open flags where available to these read/append boundaries, and verifies the opened Job log descriptor against the current regular-file path before handing it to a reader or writer. Failed validation closes the descriptor. Existing workspace file-read and Git object protections remain in place.

The isolated pre-repair existing-FIFO probe exceeded its two-second watchdog and its child was terminated. Expanded regression tests failed six assertions before the repair; the repaired initial focused run passed 26 assertions across two files. Synthetic regular-to-FIFO substitution covers ordinary reads, patch baselines, context records, Job metadata and Job log reads/appends. A separate case rejects an already present FIFO without opening it. Tests refuse to perform a blocking open so a future regression cannot strand the test process.

These are local filesystem boundary defects and regression fixtures, not evidence of an unauthenticated external exploit. Nonblocking flags prevent FIFO peer waits; they do not promise deadlines for every filesystem, device or storage failure. Existing limits on hostile local writers and portable path-based mutation still apply. Operating-system isolation remains necessary for untrusted Host shell execution.

## Candidate evidence and release acceptance

SEC17 is mandatory in the security manifest and execution/readiness checks. Tests reject its omission or substitution. The manifest identifies the source repair, while generated runtime evidence identifies the exact clean candidate; the tracked manifest must not contain its own commit hash. Shared regression files must not be counted repeatedly as unique tests.

Verification covers dependency audits, documentation, architecture and contract checks, unit/security/release tooling, builds, Worker dry runs, package smoke tests, real transport E2E, installed-package E2E and browser tests. Source-only results, earlier CI runs and mirrored provider status are not substitutes for the exact candidate's execution evidence. The final bounded report is retained separately with candidate SHA, gate results and acceptance limitations.

Stable publication still requires protected main promotion, supported native-platform and Node verification, actual required provider jobs, deployed Worker/installed Runner/host catalog agreement, a valid new immutable version, signatures, independently verified public assets and installed upgrade acceptance. Historical v0.1.3 assets must not be overwritten.
