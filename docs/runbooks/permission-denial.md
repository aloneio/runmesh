# Permission denial investigation

Version: 1
Applies to: MCP scopes, Runner/workspace policy, and live authorization
Required permissions: `coding:read`

## Goal

Identify which permission the requested action needs and where it is denied. Record the observation time because permissions are checked again when an operation runs.

## Procedure

1. Call `runner_current` and confirm that the selected Runner is the intended one. Use `workspace_list` to check the workspace ID. If your client exposes it, call `inspect` with `{"action":"diagnostics","workspace_id":"your-workspace-id"}` and record the effective permissions, policy revisions and observation time. Refresh an older catalog when the diagnostic action is missing.
2. Match the action to its required scope and workspace permission: reading uses `coding:read` and read; editing uses `coding:write` and edit; shell execution uses `coding:exec` and shell; Job input/cancel use `coding:exec` and Job control. For tools with several actions, check the permission required by the specific action.
3. Ask the administrator to check the client's scopes and Runner restrictions, the Runner authorization period, workspace permissions and policy acknowledgement. If a dependency cannot be read, keep its state unknown. Operating-system directory permissions must also allow the Runner service account to access the workspace.
4. For queued work, permission is checked again before execution. A later revocation prevents the queued Job from starting.
5. Change access only when the administrator intends to grant the requested capability, then wait for the updated policy to be acknowledged and recheck the operation. Keep the grant limited to the intended action. For an uncertain prior mutation, inspect its result before retrying.

## Exit conditions

- Stop when a concrete denying layer and required capability have been identified.
- If policy storage or the Runner is unavailable, report the explanation as incomplete rather than guessing a denial reason.
- Have the administrator repair an invalid permission record using the intended least-privilege settings.
