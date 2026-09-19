import { expect, it } from "vitest";
import { RPC_OPERATIONS, RPC_OPERATION_METHODS, RPC_OPERATION_CONTRACT, rpcOperation, rpcPermissionRequirement } from "../src/operations.js";
import { ProtectedRpcMethodSchema, isProtectedRpcMethod } from "../src/schema.js";
import { RunnerCapabilityReportSchema } from "../src/capabilities.js";

it("has exactly the 27 protected methods, with independent scope and policy ceilings", () => {
  expect(RPC_OPERATION_METHODS).toHaveLength(27);
  expect(ProtectedRpcMethodSchema.options).toEqual(RPC_OPERATION_METHODS);
  for (const method of RPC_OPERATION_METHODS) expect(rpcPermissionRequirement(method)).toBeDefined();
  expect(rpcPermissionRequirement("fs.preview_patch")).toEqual({ scope: "coding:write", permission: "edit", job: false });
  expect(rpcOperation("fs.preview_patch")?.revalidate_after_read).toBe(true);
  expect(rpcOperation("context.checkpoint")?.revalidate_after_read).toBe(false);
  expect(rpcPermissionRequirement("job.input")).toEqual({ scope: "coding:exec", permission: "job_control", job: true });
  expect(Object.isFrozen(RPC_OPERATIONS)).toBe(true);
  expect(Object.isFrozen(RPC_OPERATIONS["exec.start"])).toBe(true);
});

it("preserves every pre-refactor permission and post-read generation boundary", () => {
  const groups = [
    {methods:["env.info","workspace.list","fs.stat","fs.read","fs.list","fs.search","git.status","git.diff","git.log","git.show","git.blame","job.list","context.bootstrap","context.read","context.search","context.storage"],scope:"coding:read",permission:"read",job:false,read:true},
    {methods:["fs.preview_patch"],scope:"coding:write",permission:"edit",job:false,read:true},
    {methods:["fs.apply_patch","context.checkpoint","context.rebuild","context.prune"],scope:"coding:write",permission:"edit",job:false,read:false},
    {methods:["exec.start","exec.run"],scope:"coding:exec",permission:"shell",job:false,read:false},
    {methods:["job.get","job.logs"],scope:"coding:read",permission:"read",job:true,read:true},
    {methods:["job.cancel","job.input"],scope:"coding:exec",permission:"job_control",job:true,read:false},
  ];
  expect(groups.flatMap(group=>group.methods).sort()).toEqual([...RPC_OPERATION_METHODS].sort());
  for (const group of groups) for (const method of group.methods) {
    expect(rpcPermissionRequirement(method)).toEqual({scope:group.scope,permission:group.permission,job:group.job});
    expect(rpcOperation(method)?.revalidate_after_read).toBe(group.read);
  }
});

it.each(["constructor", "__proto__", "toString", "env.info/../exec.start", "unknown"])("unknown method %s cannot inherit a grant", method => {
  expect(rpcOperation(method)).toBeUndefined(); expect(rpcPermissionRequirement(method)).toBeUndefined();
  expect(isProtectedRpcMethod(method)).toBe(true);
});

it("validates bounded implementation reports and refuses fabricated or ambiguous capabilities", () => {
  const value = { schema_version: 1, runner_version: "0.1.3", operation_contract_sha256: RPC_OPERATION_CONTRACT.sha256,
    supported_rpc_methods: [...RPC_OPERATION_METHODS], features: { job_queue: 1, job_history: 1, context_record: 2 }, max_concurrent_jobs: 1 };
  expect(RunnerCapabilityReportSchema.safeParse(value).success).toBe(true);
  for (const override of [{schema_version:2}, {runner_version:"https://secret.invalid"}, {supported_rpc_methods:["constructor"]},
    {supported_rpc_methods:["env.info","env.info"]}, {max_concurrent_jobs:Infinity}, {hostname:"private-host"}, {features:{job_queue:1,secret:"hidden"}}]) {
    expect(RunnerCapabilityReportSchema.safeParse({...value,...override}).success).toBe(false);
  }
});
