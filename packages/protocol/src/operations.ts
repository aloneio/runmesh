import { canonicalJson, sha256Hex } from "./hash.js";

export type OperationScope = "coding:read" | "coding:write" | "coding:exec";
export type OperationPermission = "read" | "edit" | "shell" | "job_control";
export interface RpcOperationSpec {
  readonly scope: OperationScope;
  readonly permission: OperationPermission;
  readonly job: boolean;
  /** Read-only work must recheck the local policy generation before return. */
  readonly revalidate_after_read: boolean;
}
const spec = (scope: OperationScope, permission: OperationPermission, job = false, revalidate = false): Readonly<RpcOperationSpec> =>
  Object.freeze({ scope, permission, job, revalidate_after_read: revalidate });
const read = spec("coding:read", "read", false, true);
const write = spec("coding:write", "edit");
const execute = spec("coding:exec", "shell");
const jobRead = spec("coding:read", "read", true, true);
const jobControl = spec("coding:exec", "job_control", true);

/** Authoritative protected RPC contract. This describes requirements, not an
 * authorization cache. Unknown methods have no grant and stay protected. */
export const RPC_OPERATIONS = Object.freeze({
  "env.info": read, "workspace.list": read,
  "fs.stat": read, "fs.read": read, "fs.list": read, "fs.search": read,
  "fs.preview_patch": spec("coding:write", "edit", false, true), "fs.apply_patch": write,
  "git.status": read, "git.diff": read, "git.log": read, "git.show": read, "git.blame": read,
  "exec.start": execute, "exec.run": execute,
  "job.list": read, "job.get": jobRead, "job.logs": jobRead, "job.cancel": jobControl, "job.input": jobControl,
  "context.bootstrap": read, "context.read": read, "context.search": read, "context.checkpoint": write, "context.rebuild": write,
  "context.storage": read, "context.prune": write,
} satisfies Record<string, RpcOperationSpec>);
export type RpcOperationName = keyof typeof RPC_OPERATIONS;
export const RPC_OPERATION_METHODS = Object.freeze(Object.keys(RPC_OPERATIONS) as RpcOperationName[]);
export const RPC_OPERATION_CONTRACT = Object.freeze({ schema_version: 1, sha256: sha256Hex(canonicalJson(RPC_OPERATIONS)) });

export function rpcOperation(method: string): Readonly<RpcOperationSpec> | undefined {
  return Object.hasOwn(RPC_OPERATIONS, method) ? RPC_OPERATIONS[method as RpcOperationName] : undefined;
}

/** Compatibility projection consumed by the existing Registry final gate. */
export function rpcPermissionRequirement(method: string): { scope: OperationScope; permission: OperationPermission; job: boolean } | undefined {
  const operation = rpcOperation(method);
  return operation === undefined ? undefined : { scope: operation.scope, permission: operation.permission, job: operation.job };
}
