# Permission denial investigation

Version: 1  
Applies to: MCP scopes, Runner/workspace policy, and live authorization  
Required permissions: `coding:read`  

## Goal

Explain why an operation is denied using the same live authorization state that protects the operation, without widening privileges as a diagnostic shortcut.

## Procedure

1. Read the current Runner selection and layered diagnostics. Capture the effective workspace permission intersection and policy revision evidence.
2. Confirm which capability the requested action needs: read, edit, Host shell, or Job control. Mixed tools must be evaluated per action; tool visibility is not authorization.
3. Check client scope, Runner permission, workspace permission, policy generation, and Runner availability independently. Preserve `unknown` when an authority source cannot be read.
4. For queued work, remember that permission is checked again before execution. A request accepted earlier is not evidence that a later revoked request may start.
5. Use the least-privilege preset only when an administrator intentionally changes access. Hidden UI controls or documentation are never a substitute for the server-side denial.

## Exit conditions

- Stop when a concrete denying layer and required capability have been identified.
- If policy storage or the Runner is unavailable, report the explanation as incomplete rather than guessing a denial reason.
- Never repair an invalid permission record by broadening it to a default grant.
