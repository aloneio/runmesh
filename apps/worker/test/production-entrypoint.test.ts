import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import * as production from "../src/production.js";
import worker, { RegistryDOv2, RunnerDOv2 } from "../src/index.js";

it("production exports only identical live v2 classes and unchanged handlers", () => {
  expect(Object.keys(production).sort()).toEqual(["RegistryDOv2","RunnerDOv2","default"]);
  expect(production.default).toBe(worker);
  expect(production.RegistryDOv2).toBe(RegistryDOv2);
  expect(production.RunnerDOv2).toBe(RunnerDOv2);
});

it("v2 state remains readable through the production class export", async () => {
  const stub=env.REGISTRY.get(env.REGISTRY.idFromName(`retirement-v2-${crypto.randomUUID()}`));
  await runInDurableObject(stub,(instance,state)=>{
    instance.registerRunner("retained","a".repeat(64),Date.now(),undefined,"dedicated_user");
    const before=instance.getRunnerExecutionState("retained");
    const same=new production.RegistryDOv2(state,env);
    expect(same.getRunnerExecutionState("retained")).toEqual(before);
    expect(before?.runner.runner_id).toBe("retained");
  });
});
