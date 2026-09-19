# Final admission and bounded receipt audit - 2026-09-17

> Historical reference: the results, settings and actions below apply to the stated version or review period. For current use, follow the [documentation index](README.md), [upgrade guide](upgrading.md) and [release status](release-readiness.md).

## Scope

The audit started from dev `a84ecee35737423b1ae039ead00a82c855b4cd0c` in an isolated detached worktree on oci0. The original checkout and its uncommitted changes were preserved. Dependency installation, tests and Git operations use the repository owner rather than the connected Host shell's root identity. A separate npm cache avoids the existing shared-cache ownership problem. No production deployment, installed Runner replacement, stable publication, main promotion or old-file deletion was performed.

## Confirmed defects and source repairs

| Boundary | Reproduction | Repair |
| --- | --- | --- |
| Final bridge access and authorization | Incomplete HTTP 2xx receipts could be treated as completed access or authorization decisions. Inconsistent denial-status grant bodies were misclassified. | Require completed 200 grants. Only explicit negative 200/403/409 decisions represent denial; other final authorization observations report dependency unavailability before dispatch. |
| Queued execution | Non-completed 2xx decisions could authorize dequeue. A later policy fence could reject authorization while retaining an earlier recording flag. | Reauthorize through the same bounded completed-receipt contract; the final policy/session fence gates both execution authorization and recording permission. |
| Control-plane and completion parsing | Oversized or expired JSON receipts and malformed UTF-8 could be accepted. Fragment arrays could amplify memory use. | Bound Registry observations to five seconds; use 16 KiB for authority/selection/audit receipts and 1 MiB for snapshots and Runner completion bodies. Decode UTF-8 strictly and copy chunks into one bounded buffer. Abort/cancel expired or rejected observations. Preserve the Runner's existing dispatch wait budget. |
| Registry Job identity | An offline lookup for one Job could return another Job's metadata; an online lookup could proceed using a mismatched snapshot. | Bind the snapshot Job ID to the requested ID before permission checks, metadata projection or dispatch. Never discover another workspace or replay a command. |

The authorization fixtures inject faulty internal responses using synthetic test credentials. They establish defects at those boundaries, not a proven unauthenticated external exploit or a bypass of every downstream check.

The source repair is `7b670a95ed84900df12bed07677f911f7ed58a73`. Mandatory findings SEC14-SEC16 retain the final-admission, bounded-observation and Job-identity regressions.

## Executed reproduction and acceptance boundary

Before the source repairs, the expanded bridge/queue tests had 18 failures and 29 passes; the MCP boundary suite had 10 failures and 156 passes. All 354 assertions in the first repaired six-file focused run passed without skips. An exploratory dev-push CI change passed focused CI tests but failed the existing deployment-cost regression. It was withdrawn after confirming that dev verification intentionally runs on GitHub before mirroring to GitLab; the existing main/MR/manual/scheduled GitLab policy is retained. Additional stream regressions cover stalled bodies, late responses after abort, explicit denial parsing and reused byte buffers.

Fresh clean-candidate verification must run after committing the complete source and security manifest. Reports from the initial `a84ecee` baseline, dirty intermediate worktrees or earlier CI runs do not approve the final candidate. The manifest binds the added boundaries to the source repair and their executable regression files. Counts for findings that share files must not be summed as unique tests.

## External acceptance still required

At the starting commit, GitHub CI run `35226992963` passed. GitLab pipeline `2858261737` was successful with `source: external`, not evidence that GitLab's native verify/browser jobs executed. This is expected for mirrored dev pushes and is not a substitute for mandatory native release-candidate verification. The project intentionally uses `.gitlab/main-policy.yml@aloneio/runmesh:dev`, which includes the exact source revision and supplies the trusted main-source policy; this setting must not be replaced with an untrusted source-only entrypoint.

The connected host still advertised nine tools. Its `job.get` schema rejected the latest source's workspace-bound argument; lookup without that argument returned a generic cloud-history `not_found` for a real local Job. Source tests do not prove that the deployed Worker, installed Runner and cached host catalog have been upgraded together.

A stable release still requires the exact protected main candidate, the supported native-platform and Node matrix, actual required provider jobs, current host-catalog acceptance, a new valid immutable version, signatures, independently verified public assets and installed upgrade acceptance. The historical v0.1.3 release record is not approval for these changes.
