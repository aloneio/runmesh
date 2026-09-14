import { expect, it } from "vitest";
import { ProtectedRpcMethodSchema } from "@aloneio/runmesh-protocol";
import { rpcPermissionRequirement } from "../src/mcp-authorization.js";

it("every declared protected RPC has an explicit final authorization mapping", () => {
  for (const method of ProtectedRpcMethodSchema.options) expect(rpcPermissionRequirement(method), method).toBeDefined();
  expect(rpcPermissionRequirement("unknown.rpc")).toBeUndefined();
  expect(rpcPermissionRequirement("echo")).toBeUndefined();
});
it("context, diagnostics and preview retain their exact scope ceilings", () => {
  for (const method of ["env.info", "context.bootstrap", "context.read", "context.search"]) expect(rpcPermissionRequirement(method)).toEqual({ scope:"coding:read", permission:"read", job:false });
  for (const method of ["fs.preview_patch", "context.checkpoint", "context.rebuild"]) expect(rpcPermissionRequirement(method)).toEqual({ scope:"coding:write", permission:"edit", job:false });
});
