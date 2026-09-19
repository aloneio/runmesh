# Pre-release security audit — 2026-09-17

> Historical reference: the results, settings and actions below apply to the stated version or review period. For current use, follow the [documentation index](README.md), [upgrade guide](upgrading.md) and [release status](release-readiness.md).

## Source and release boundary

The audit began at dev commit `4861aa5b2c2900b79d80ed4e1effb50f53d2abd7` in an isolated detached worktree. The existing v0.1.3 assets are immutable; these post-release changes are not part of those artifacts. A subsequent stable candidate needs a new version, protected dev-to-main promotion, exact-source provider checks, signing and independent artifact verification. Local checks neither deploy production nor upgrade an installed Runner.

The checked-in [security ledger](../release/security-readiness.json) identifies reviewed fixes and owned regressions. `npm run test:security` executes those files, reads actual Vitest assertions and checks the current clean commit. It rejects skipped, failed, missing, duplicate or unowned suites and inconsistent counts. A failed attempt replaces stale passing evidence. Both verification providers run this blocking gate; the release job regenerates it before signing rather than assuming a previous job's local files exist. The report is self-reported execution evidence, not a cryptographic attestation or production acceptance.

## Confirmed defects and repairs

Eleven preserved adversarial probes were rerun at the baseline. Eight failed: six Worker cases and two Runner cases. Runner-list outage handling, policy-readiness outage handling and revoked-MCP-principal rejection already passed. The original probes remain as ordinary tracked regressions, with additional race, outage and object-link cases.

| Finding | Repair and regression ownership |
| --- | --- |
| SEC01 | Recheck a browser session after its awaited body/CSRF work; bind the request-local session hash into the authenticated internal target and verify it at Registry mutation admission. Tests revoke sessions or rotate the password immediately before the signed credential-creation write. |
| SEC02 | Capture canonical root/device/inode at policy admission, not lazily on the first request. Reject root replacement and ancestor redirection before and after path resolution/snapshots. |
| SEC03 | Do not give isolated Git a live alternate pointing at the source object database. Copy bounded regular objects through checked descriptors; reject directory, object, pack and info links. |
| SEC04 | Distinguish explicit session denial from dependency failure, malformed JSON, oversized responses and timeout. Availability failures return 503 without clearing cookies. |
| SEC05 | Password changes use the same bounded, validated settings observation as login; unavailable settings are not an incorrect current password. |
| SEC06 | Preserve the existing runner-list permission-outage rejection and retain its regression. |
| SEC07 | Do not silently omit snapshot Jobs when their permission dependency fails; only an actual permission denial filters a Job. |
| SEC08 | Reject a malformed workspace catalog instead of converting it to successful empty discovery. |
| SEC09 | Preserve the existing distinction between unavailable readiness and stale policy. |
| SEC10 | Validate final public and Context-specific receipts before persisting audit success. Preserve safe operation identifiers and the resulting audit receipt on errors; never infer rollback or permission to replay a mutation. |

Worker ownership: `apps/worker/test/release-admin-security.test.ts` and `apps/worker/test/release-mcp-security.test.ts`. Runner ownership: `apps/runner/test/release-boundary-security.test.ts`. Evidence-parser adversarial checks: `test/security-evidence.test.mjs`. The existing no-record, authorization, native Git, packaging and real transport tests remain independently required.

## Explicit operational limits

Administrator session/settings observations allow at most 16 KiB and five seconds, with request abort and response-reader cancellation. An unavailable dependency never grants authority.

Git object snapshots have a 256 MiB aggregate byte ceiling, 32,768-entry ceiling, maximum directory depth of three below objects, and five-second cooperative preparation budget (or the caller's earlier deadline). Oversized/unsupported stores fail closed with `git_unavailable`; the implementation does not fall back to live alternates. This adds disk I/O compared with the prior unsafe alternate. Native CI remains required for normal supported repositories, including packed objects.

On Linux, object-directory traversal is descriptor-pinned. Other native platforms use identity checks around descriptor-based copies. These checks are not proof against every hostile local ABA race, kernel-I/O stall or a privileged local writer. A workspace is not an operating-system sandbox, and this audit does not change the intentionally authorized shell/execution mode.

Root identity remains tied to the admitted policy. Replacing a legitimate workspace directory requires explicit policy re-admission rather than silently adopting a new inode. An immutable source snapshot is not promised for concurrently edited repository contents.

## Acceptance still separate from source verification

The security lane requires Linux so its boundary probes cannot silently skip. Windows/macOS and both supported Node LTS lanes remain mandatory provider checks. Browser tests, packaged transport, current connector catalog, production runtime, account quotas and independently verified signed release assets remain distinct evidence categories. A green local suite must not be reported as completion of an unrun external category.
