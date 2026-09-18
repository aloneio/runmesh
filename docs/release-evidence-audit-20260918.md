# Release evidence input audit - 2026-09-18

## Scope and baseline

This review starts from `f9d8bfd848f35a909187fa157eb06c49e689531b` on oci0. The original dev checkout was clean and had only main/dev branches. An isolated detached worktree holds this repair. Tests and Git operations use the repository owner, not the root identity of the installed Runner. No production deployment, installed Runner restart, immutable release replacement or main promotion is part of this repair.

## Verification-input reliability defects

The package verification wrapper checked paths with lstat and then opened them again through readFile. This left its existing regular-file, non-symlink and eight-MiB limits unenforced when a file changed between those operations. The post-test archive hash read had no descriptor-bound limit either. Similar reads existed in installed-package gate ingestion and the security regression/readiness tools.

Five deterministic subprocess regressions failed on the original wrapper: report growth, archive growth, invalid UTF-8, a report changed into a FIFO, and a report changed into a symbolic link. Four malformed cases incorrectly returned success. The FIFO case required its three-second subprocess watchdog. The fixtures use only their own temporary files and instrument the public filesystem interface in the isolated subprocess; they do not race against production files or change a running service.

## Repair

The small `scripts/evidence-io.mjs` adapter owns verification-input reads. It checks a bounded regular file, opens with nonblocking/no-follow flags where supported, verifies the opened descriptor against the path observation, and reads no more than the caller's cap plus one byte. Descriptor metadata and the actual byte count are checked again after EOF. Every opened descriptor is closed. JSON uses fatal UTF-8 decoding instead of silently substituting invalid bytes.

The package wrapper now derives both its digest and byte count from the same bounded buffer, rechecks its archive through the same adapter, and uses the adapter for its raw test report. `ci-check.mjs`, `run-security-regressions.mjs` and `check-release-readiness.mjs` share this boundary instead of maintaining independent path-stat/read sequences. Existing failed-attempt replacement and candidate-identity checks remain in place.

This is verification-tool reliability hardening, not a new runtime authorization model. It does not establish an atomic filesystem snapshot, an I/O deadline for regular/network filesystems, or protection against an actor who can replace the verifier itself. No new SEC runtime finding ID is manufactured for Node-only tooling: package verification regressions already execute in the mandatory tooling lane and the existing native verification commands.

## Recorded local verification and limits

After the repair, all 12 then-current package verification tests passed without skips, including all five previously failing cases. The full then-current release-tool suite reported 386 passed, zero failed and five conditionally skipped tests. The baseline full unit command passed, and npm audit reported zero known vulnerabilities. These observations are not an exact-clean-final-candidate release certificate.

Two additional package-wrapper regressions cover growth after descriptor stat and immediately after EOF, and a direct reader test covers valid multibyte JSON at its exact byte limit and invalid bounds/types. Their subsequent execution request was blocked by the tool platform, so their presence is not claimed as executed evidence here. The batch installation/static-gate requests were also blocked and were not executed or counted as passing. The audit worktree reuses existing dependencies through an untracked node_modules link; no fresh npm ci or clean-source security certificate is claimed for that worktree. Later verification must record its own source and results.

## Independent deployed-component blockers

The baseline GitHub CI and Dev Runner Prerelease runs succeeded, but the matching GitLab external pipeline `2859840705` failed in `Workers Builds: runmeshdev`. Its Cloudflare build ID is `af77d360-bc8e-42ac-8ee1-141b0e15e4a0`. The external pipeline has no native GitLab jobs. The actual Cloudflare error log was not obtained; no root cause is invented from the failed status.

A fresh dev health response still identified clean source `4a3d2a461c6400603c781d6f720fa66b02fcbf35`, not the baseline or this repair. Health advertised ten MCP tools including context, while this host exposed only nine and omitted context. A live shell receipt followed by job.get also reproduced the stale Registry not_found response and an inappropriate runner-discovery recovery hint. These are deployed-component/host acceptance gaps, not evidence that this Node-only repair upgraded those components.

Formal publication remains blocked until exact-candidate checks and the Worker/Runner/host acceptance chain are separately verified. The historical v0.1.3 release record does not approve later dev repairs.
