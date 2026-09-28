import { mkdtemp, mkdir, lstat, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { RPC_OPERATION_METHODS, RPC_OPERATION_CONTRACT, RunnerCapabilityReportSchema } from "@aloneio/runmesh-protocol";
import { RunnerRuntime } from "../src/runtime.js";
import type { EnvironmentWorkspace } from "../src/environment-contracts.js";
import { EnvironmentInfoService } from "../src/environment.js";
import { discoverCapabilities } from "../src/connection.js";

it("accepts a structural environment reader and supplies the current readable workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "environment-reader-"));
  try {
    const workspace = { workspaceId: "visible", rootPath: await realpath(root), readonly: true, shell: false };
    const get = vi.fn(async (workspaces: readonly EnvironmentWorkspace[]) => ({ source: "injected", workspaces }));
    const runtime = new RunnerRuntime({ config: { server: "ws://127.0.0.1", token: "test-token", runnerId: "test-runner", workspaces: [workspace] }, environment: { get } });
    expect(await runtime.envInfo()).toMatchObject({ source: "injected", workspaces: [{ workspaceId: "visible" }] });
    runtime.applyPolicy([{ ...workspace, workspaceId: "replacement" }]);
    expect(await runtime.envInfo()).toMatchObject({ source: "injected", workspaces: [{ workspaceId: "replacement" }] });
    expect(get).toHaveBeenCalledTimes(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("R01 advertises the same protected operations and returns bounded capability evidence without persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "capability-report-"));
  const directory = join(root, "workspace"); await mkdir(directory);
  const stateDir = join(root, "not-created");
  const probe = vi.fn(async () => "synthetic-version");
  const runtime = new RunnerRuntime({ config: { server:"ws://127.0.0.1",token:"private-synthetic-token",runnerId:"private-runner-id",
    workspaces:[{workspaceId:"w",rootPath:await realpath(directory),readonly:true,shell:false}],maxConcurrentJobs:2 },stateDir,environment:new EnvironmentInfoService({probe}) });
  try {
    const report = (await runtime.envInfo()).runtime_capabilities;
    expect(RunnerCapabilityReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({schema_version:1,operation_contract_sha256:RPC_OPERATION_CONTRACT.sha256,max_concurrent_jobs:2,features:{context_record:2}});
    expect(discoverCapabilities(2).supported_rpc_methods).toEqual(["echo","runner.info",...RPC_OPERATION_METHODS]);
    for (let i=0;i<100;i++) expect((await runtime.envInfo()).runtime_capabilities).toEqual(report);
    expect(probe).toHaveBeenCalledTimes(8);
    const encoded = JSON.stringify(report);
    for (const value of [root,"private-synthetic-token","private-runner-id"]) expect(encoded).not.toContain(value);
    expect(Buffer.byteLength(encoded)).toBeLessThan(2048);
    await expect(lstat(stateDir)).rejects.toMatchObject({code:"ENOENT"});
    // The shared operation flags must preserve the original post-read guard.
    const original = runtime.policy.list();
    const envInfo = vi.spyOn(runtime,"envInfo").mockImplementation(async () => {runtime.applyPolicy(original); return {runtime_capabilities:report};});
    await expect(runtime.dispatch("env.info",{})).rejects.toMatchObject({code:"stale_policy"});
    envInfo.mockRestore();
  } finally { await rm(root,{recursive:true,force:true}); }
});
