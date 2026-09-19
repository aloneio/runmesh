# Release-tool input audit - 2026-09-18

> Historical reference: the results, settings and actions below apply to the stated version or review period. For current use, follow the [documentation index](README.md), [upgrade guide](upgrading.md) and [release status](release-readiness.md).

## Scope and baseline

This review starts from dev `3c18b5e96485c1d33f0c024f4018fec65f94d074` in an isolated detached worktree on oci0. The original dev checkout has existing uncommitted work and is preserved, not reset, rebased or overwritten. Verification and repair run as the repository owner, not the root identity used by the installed Host shell service. The existing shared npm cache contains root-owned entries; this review uses a separate cache instead of changing shared permissions.

The unmodified baseline passed all 26 declared CI gates locally. Those results do not approve later changes. GitHub's baseline verify-all and required runtime jobs passed, while GitLab's external pipeline `2858652641` reported a failed `Workers Builds: runmeshdev` build and contained no native GitLab jobs. A missing provider build log is not evidence of a particular build root cause.

## REL01: release and catalog inputs can block before validation

Both `readBoundedReleaseFile` and `readCatalog` opened their input in blocking read mode before checking the descriptor's file type. A FIFO without a writer therefore waited inside open, before either the regular-file check or the byte limit could run. This affects local release manifest/signature/artifact reading and local MCP catalog verification, not an unauthenticated remote authorization boundary.

Two isolated pre-repair probes were terminated by a two-second watchdog (exit 124). Two newly added regression tests failed against the original readers, with each subprocess killed by its watchdog and its fixture removed. Tests cover direct FIFO paths and symlinks to FIFOs; they never supply a writer to make a blocking implementation pass.

The repair uses read-only, nonblocking open flags where the platform supports them, then retains the existing descriptor-type checks, byte bounds and finally-based descriptor closure. Ordinary file and symlink resolution behavior is not deliberately changed. Nonblocking open prevents the FIFO peer wait; it does not promise deadlines for regular-file, network-filesystem or device I/O.

The focused post-repair run passed all 25 tests in `test/release-tools.test.mjs` and `test/mcp-connector.test.mjs`, with no skips. Both files already belong to the mandatory tooling gate and test inventory. They remain tooling regressions rather than being misclassified as Worker/Runner runtime evidence in the separate security manifest.

## Candidate verification and acceptance boundaries

Full post-repair verification must identify the exact clean candidate, including all 26 declared gates and real browser E2E. Its final result is retained with that candidate in the companion evidence directory; neither the earlier baseline nor the focused test run is a substitute. The initial default Playwright browser path was absent on oci0. A local browser run may use the explicitly supported system Chromium override and must identify that runtime rather than claiming the lockfile-pinned browser was installed.

At this review's live check, dev health was available but still identified `4a3d2a461c6400603c781d6f720fa66b02fcbf35`, not the audited dev baseline. Production health did not identify a source commit. The current host's callable MCP surface lacked the source catalog's context tool and workspace-bound Job parameters; a returned Shell job identifier subsequently produced an unavailable Registry lookup. Source repairs, deployed Worker identity, installed Runner identity and host catalog freshness require separate acceptance.

No production deployment, installed Runner restart, main promotion, stable publication, force push, new named branch or old-file deletion is part of this repair. The active system service executes as root, so Host shell operations are not an operating-system sandbox; changing its user or restarting it while auditing would interrupt active jobs and is not performed implicitly. Existing immutable v0.1.3 assets must remain unchanged, and later dev work still requires a new stable version and the protected release process.
