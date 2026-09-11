/** Scope and policy ceilings are different boundaries: exec must not silently
 * substitute for the independently required read/write tool scope. */
export function rpcPermissionRequirement(method: string): { scope: "coding:read" | "coding:write" | "coding:exec"; permission: "read" | "edit" | "shell" | "job_control"; job: boolean } | undefined {
  switch (method) {
    case "fs.stat": case "fs.read": case "fs.list": case "fs.search": case "git.status": case "git.diff": return { scope: "coding:read", permission: "read", job: false };
    case "fs.apply_patch": return { scope: "coding:write", permission: "edit", job: false };
    case "exec.start": case "exec.run": return { scope: "coding:exec", permission: "shell", job: false };
    case "job.get": case "job.logs": return { scope: "coding:read", permission: "read", job: true };
    case "job.cancel": case "job.input": return { scope: "coding:exec", permission: "job_control", job: true };
    default: return undefined;
  }
}
