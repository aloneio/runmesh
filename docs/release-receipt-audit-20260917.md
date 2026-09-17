# Pre-release receipt and Runner identity audit - 2026-09-17

## Scope and acceptance boundary

This audit started from `31bdbcbba1e93bb9583f038aa5ad16db10038c66` in a separate detached worktree on oci0. The original checkout contained uncommitted work and was not reset, rebased or overwritten. Repository installation, tests and Git commands ran as the repository owner, not the root identity used by the connected Host shell. A separate npm cache avoided changing the shared cache. No production deployment, installed Runner replacement, main promotion, stable publication or old-file cleanup was performed.

The source repair is `bc7883b62db6a36a5f6984467cf4bf6c3f907145`. Source closure is not stable-release approval. A clean candidate needs its own full verification, provider results, deployed-component acceptance and publication evidence. Earlier CI results do not verify these changes.

## Confirmed defects and repairs

| Boundary | Reproduced failure | Repair |
| --- | --- | --- |
| RPC authorization preflight | An inconsistent authorization response could carry `ok: true` with an unexpected success, denial or conflict HTTP status and still reach Runner dispatch. | Require the completed `200` contract. Denial/conflict receipts must explicitly contain `ok: false`. An unverified preflight never dispatches and reports `not_started`. |
| RPC completion | A partial or accepted HTTP response containing an RPC success payload could be reported as completed success. | Only `200` confirms the bridge completion. Other receipts retain an ambiguous execution state; no automatic replay is introduced. |
| Registry snapshots | A non-completed successful HTTP status could supply a trusted snapshot. | Only `200` supplies snapshot data. Discard and cancel other bodies without waiting for their completion. |
| Sticky Runner identity | Unvalidated selection data could be malformed, disagree about the active Runner identity or acknowledge a different Runner than the requested selection. | Validate and project the selection before using it. Require matching Runner identifiers, defined connection states, coherent availability and safe nullable timestamps. Reject malformed state without selecting another Runner. |

These fixtures simulate faulty internal responses with synthetic credentials. They demonstrate contract failures at the tested boundaries, not an external credential-free exploit or a bypass of every downstream authorization layer.

Audit recording has a different contract: the Registry legitimately returns `202` with `disabled` or `degraded`. The repair gives only the audit caller an explicit receipt mode for these values. That mode cannot turn the same response into an authorization grant or a confirmed recorded audit. No-cloud-history operation remains supported.

## Executed reproduction

Before the repair, the expanded failure-chain suite produced **27 failures and 110 passes**. After the initial repair, all **137** assertions passed. Subsequent positive, cancellation and audit-compatibility coverage expanded that suite to **155** assertions. The final focused run passed all **220** assertions across that suite and the existing 65-case no-record suite, with no skips. Type checking also passed.

An intermediate broad verification executed 24 gate commands: 23 passed, including dependencies, static checks, build, three Worker configurations, package smoke and source/installed-package transport. Its unit lane correctly caught three audit receipt compatibility failures caused by an overly broad initial `200` requirement. The audit-specific repair above resolved those failures in the focused run. This intermediate batch is not claimed as final clean-candidate acceptance.

The mandatory security manifest now includes SEC12 (completion receipts) and SEC13 (sticky identity), tied to the source repair and the executable failure-chain suite. The evidence collector executes each owned file once; per-finding counts sharing a file must not be summed as unique tests. Closure and evidence tests reject removal or substitution of either finding. Fresh clean-candidate gate reports are generated outside tracked source by the standard CI commands.

## Observed deployment and provider gaps

At the starting commit, GitHub CI run `35223760870` was successful. GitLab pipeline `2858147729` was also green, but reported `source: external`; that alone does not prove that GitLab's own mandatory verification jobs ran. Stable publication must continue to require the exact protected main commit and actual required jobs on both providers, rather than weakening the cross-provider gate.

The connected chat host exposed nine tools. A newly created local Job was visible through workspace-bound live listing, but history-based `job.get` returned `not_found`. That observed installed-component behavior must be checked against fresh source, server and host catalogs; passing tests in this worktree do not establish that the live connector was upgraded.

Some unrelated host-inspection calls were rejected by the tool platform. Those calls are not counted as executed verification, and no unobserved provider configuration or deployment state is asserted here. Final release acceptance still requires the supported native-platform matrix, browser lane, exact-candidate checks, protected dev-to-main promotion, a fresh valid release version, signatures, independent public-asset verification and installed upgrade acceptance. Existing stable assets must remain immutable.
