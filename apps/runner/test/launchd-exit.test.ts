import { expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForLaunchdExit } from "../src/services/launchd.js";
import { createLaunchdStopRecovery, hostLaunchdStopRecoveryFilesystem, type LaunchdStopRecoveryFilesystem } from "../src/services/launchd-stop.js";

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

it.each(["create", "sync", "remove"] as const)("retries a stopped process after recovery-record %s fails", async fault => {
  let record: string | undefined, loaded = true, fail = true;
  const calls: string[][] = [];
  const filesystem: LaunchdStopRecoveryFilesystem = {
    read: async () => record,
    create: async (_path, text) => { record = text; if (fail && fault === "create") throw new Error("publication interrupted"); },
    sync: async () => { if (fail && fault === "sync") throw new Error("sync interrupted"); },
    remove: async () => { if (fail && fault === "remove") throw new Error("remove interrupted"); record = undefined; },
  };
  const options = { mode: "system" as const, manifestPath: "/fixture/runner.plist", filesystem, target,
    executor: { execute: async (file: string, args: readonly string[]) => {
      calls.push([file, ...args]);
      if (args[0] === "print") return loaded ? { exitCode: 0, stdout: "state = running\npid = 123" } : absent;
      if (args[0] === "bootout") loaded = false;
      if (file === "ps") return { exitCode: 1 };
      return { exitCode: 0 };
    } },
  };
  await expect(createLaunchdStopRecovery(options).stop({ disable: true })).rejects.toThrow("interrupted");
  expect(JSON.parse(record!).pid).toBe(123);
  if (fault !== "remove") expect(calls.some(call => call.includes("disable") || call.includes("bootout"))).toBe(false);
  fail = false;
  await createLaunchdStopRecovery(options).stop({ disable: true });
  expect(record).toBeUndefined();
  expect(calls.filter(call => call.includes("bootout"))).toHaveLength(1);
  expect(calls.filter(call => call[0] === "ps").at(-1)).toEqual(["ps", "-p", "123", "-o", "pid="]);
});

it("keeps the previous PID until it exits before recording a replacement job", async () => {
  let record: string | undefined = JSON.stringify({ schema_version: 1, target, mode: "system", pid: 123 });
  let previousAlive = true, loaded = true;
  const calls: string[][] = [];
  const port = createLaunchdStopRecovery({ mode: "system", manifestPath: "/fixture/runner.plist", target,
    filesystem: { read: async () => record, create: async (_path, text) => { record = text; }, sync: async () => undefined, remove: async () => { record = undefined; } },
    executor: { execute: async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "print") return loaded ? { exitCode: 0, stdout: "state = running\npid = 456" } : absent;
      if (args[0] === "bootout") loaded = false;
      if (file === "ps") return args[1] === "123" ? { exitCode: previousAlive ? 0 : 1 } : { exitCode: 2, stderr: "query interrupted" };
      return { exitCode: 0 };
    } },
  });
  await expect(port.stop()).rejects.toThrow("Previous Runner process is still active");
  expect(calls.some(call => call.includes("bootout"))).toBe(false);
  expect(JSON.parse(record!).pid).toBe(123);
  previousAlive = false;
  await expect(port.stop()).rejects.toThrow("exit could not be confirmed");
  expect(JSON.parse(record!).pid).toBe(456);
});

it.skipIf(process.platform === "win32")("persists recovery records across host adapter instances in a temporary directory", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runmesh-launchd-recovery-")));
  const path = join(directory, "runner.plist.purge-stop.json");
  const text = JSON.stringify({ schema_version: 1, target, mode: "system", pid: 123 });
  try {
    expect(await hostLaunchdStopRecoveryFilesystem.read(path)).toBeUndefined();
    await hostLaunchdStopRecoveryFilesystem.create(path, text);
    await hostLaunchdStopRecoveryFilesystem.sync(path);
    expect(await hostLaunchdStopRecoveryFilesystem.read(path)).toBe(text);
    await expect(hostLaunchdStopRecoveryFilesystem.create(path, text)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await hostLaunchdStopRecoveryFilesystem.read(path)).toBe(text);
    await hostLaunchdStopRecoveryFilesystem.remove(path);
    expect(await hostLaunchdStopRecoveryFilesystem.read(path)).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
