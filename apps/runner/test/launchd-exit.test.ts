import { expect, it } from "vitest";
import { waitForLaunchdExit } from "../src/services/launchd.js";

const absent = { exitCode: 113, stderr: "Could not find service" };
const target = "system/io.alone.runmesh.runner";

it("waits for both the launchd registration and its original process to disappear", async () => {
  let clock = 0, prints = 0, processes = 0;
  await waitForLaunchdExit({ execute: async (file, args) => {
    if (file === "launchctl") {
      expect(args).toEqual(["print", target]);
      return ++prints < 3 ? { exitCode: 0, stdout: "state = running\npid = 4321" } : absent;
    }
    expect(args).toEqual(["-p", "4321", "-o", "pid="]);
    return ++processes === 1 ? { exitCode: 0, stdout: "4321" } : { exitCode: 1 };
  } }, target, 4321, { now: () => clock, delay: async ms => { clock += ms; } });
  expect(prints).toBe(4); expect(processes).toBe(2); expect(clock).toBe(300);
});

it.each(["registration", "process"])("bounds the wait for a lingering %s", async lingering => {
  let clock = 0, calls = 0;
  await expect(waitForLaunchdExit({ execute: async file => {
    calls++;
    return file === "launchctl" && lingering === "process" ? absent : { exitCode: 0, stdout: "4321" };
  } }, target, 4321, { now: () => clock, delay: async ms => { clock += ms; } })).rejects.toThrow("cleanup deadline");
  expect(clock).toBe(5_000); expect(calls).toBeLessThanOrEqual(102);
});

it.each(["registration", "process"])("rejects an unavailable %s probe", async unavailable => {
  let waits = 0;
  await expect(waitForLaunchdExit({ execute: async file => {
    return file === "launchctl" && unavailable === "process" ? absent : { exitCode: 1, stderr: "Operation not permitted" };
  } }, target, 4321, { delay: async () => { waits++; } })).rejects.toThrow(/could not be (verified|confirmed)/u);
  expect(waits).toBe(0);
});
