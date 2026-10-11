import { expect, it } from "vitest";
import { uninstall } from "../src/cli/lifecycle.js";
import { createServiceManager, renderService, serviceLayout, serviceProfilePath } from "../src/service.js";
import type { ServiceManagerOptions } from "../src/services/contracts.js";

function fixture() {
  const manifest = renderService({ platform: "darwin", mode: "system", executionMode: "privileged_host" });
  const recordPath = `${manifest.path}.purge-stop.json`;
  const files = new Map([[manifest.path, manifest.content]]);
  const calls: string[][] = [];
  const state = { loaded: true, process: "denied" as "denied" | "alive" | "gone", clock: 0, bootstrapFailures: 0 };
  const filesystem = {
    read: async (path: string) => files.get(path),
    write: async (path: string, text: string) => { files.set(path, text); },
    remove: async (path: string) => { files.delete(path); },
  };
  const recovery = {
    read: filesystem.read,
    create: async (path: string, text: string) => {
      calls.push(["record", "create", path]);
      if (files.has(path)) throw new Error("record already exists");
      files.set(path, text);
    },
    sync: async (path: string) => { calls.push(["record", "sync", path]); },
    remove: async (path: string) => { calls.push(["record", "remove", path]); files.delete(path); },
  };
  const executor = { execute: async (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    if (file === "ps") {
      expect(args).toEqual(["-p", "4321", "-o", "pid="]);
      return state.process === "denied" ? { exitCode: 1, stderr: "Permission denied" }
        : state.process === "alive" ? { exitCode: 0, stdout: "4321\n" } : { exitCode: 1 };
    }
    if (file !== "launchctl") throw new Error(`unexpected program: ${file}`);
    if (args[0] === "print") return state.loaded ? { exitCode: 0, stdout: "state = running\npid = 4321\n" }
      : { exitCode: 113, stderr: "Could not find service" };
    if (args[0] === "bootout") { state.loaded = false; return { exitCode: 0 }; }
    if (args[0] === "bootstrap") {
      if (state.bootstrapFailures-- > 0) return { exitCode: 5, stderr: "Service already loaded" };
      state.loaded = true;
      return { exitCode: 0 };
    }
    if (args[0] === "enable" || args[0] === "kickstart") return { exitCode: 0 };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  } };
  const options = { platform: "darwin", mode: "system", executor, filesystem, stopRecoveryFilesystem: recovery,
    now: () => state.clock, delay: async (ms: number) => { state.clock += ms; } } satisfies ServiceManagerOptions;
  const manager = () => createServiceManager(options);
  const remember = () => files.set(recordPath, JSON.stringify({ schema_version: 1, target: "system/io.alone.runmesh.runner", mode: "system", pid: 4321 }));
  return { manifest, recordPath, files, calls, state, filesystem, recovery, options, manager, remember };
}

it("preserves the original process identity across ordinary macOS stop retries", async () => {
  const test = fixture();
  await expect(test.manager().stop(test.manifest)).rejects.toThrow("could not be confirmed");
  expect(JSON.parse(test.files.get(test.recordPath)!)).toMatchObject({ pid: 4321 });
  const synced = test.calls.findIndex(call => call[0] === "record" && call[1] === "sync");
  expect(synced).toBeGreaterThanOrEqual(0);
  expect(synced).toBeLessThan(test.calls.findIndex(call => call[1] === "bootout"));
  await expect(test.manager().stop(test.manifest)).rejects.toThrow("could not be confirmed");
  expect(test.calls.filter(call => call[0] === "ps")).toHaveLength(2);
  expect(test.files.has(test.manifest.path)).toBe(true);
  test.state.process = "gone";
  await test.manager().stop(test.manifest);
  expect(test.files.has(test.recordPath)).toBe(false);
  expect(test.calls.filter(call => call[1] === "bootout")).toHaveLength(1);
});

it("retains the ordinary macOS uninstall manifest until the original process is confirmed gone", async () => {
  const test = fixture();
  const store = { filePath: serviceProfilePath(serviceLayout({ platform: "darwin", mode: "system" })),
    load: async () => undefined, save: async () => undefined, remove: async () => undefined, assertServiceOwnership: async () => undefined };
  const run = () => uninstall({ command: "uninstall", json: true, values: {}, passthrough: [] }, store, () => undefined,
    { servicePlatform: "darwin", serviceManager: test.manager(), serviceFilesystem: test.filesystem, isAdministrator: () => true });
  await expect(run()).rejects.toThrow("could not be confirmed");
  expect(test.files.has(test.manifest.path)).toBe(true);
  await expect(run()).rejects.toThrow("could not be confirmed");
  expect(test.files.has(test.manifest.path)).toBe(true);
  test.state.process = "gone";
  await run();
  expect(test.files.has(test.manifest.path)).toBe(false);
  expect(test.files.has(test.recordPath)).toBe(false);
});

it.each(["install", "restart"] as const)("recovers an interrupted macOS purge before ordinary %s", async action => {
  const test = fixture();
  test.state.loaded = false;
  test.remember();
  await expect(test.manager()[action](test.manifest)).rejects.toThrow("could not be confirmed");
  expect(test.calls.some(call => call[1] === "bootstrap" || call[1] === "kickstart")).toBe(false);
  expect(test.files.has(test.recordPath)).toBe(true);
  test.state.process = "gone";
  await test.manager()[action](test.manifest);
  expect(test.files.has(test.recordPath)).toBe(false);
  expect(test.calls.some(call => call[1] === "bootstrap")).toBe(true);
});

it("retains recovery state when macOS install needs to unload an existing registration", async () => {
  const test = fixture();
  test.state.bootstrapFailures = 1;
  await expect(test.manager().install(test.manifest)).rejects.toThrow("could not be confirmed");
  expect(test.calls.filter(call => call[1] === "bootstrap")).toHaveLength(1);
  expect(test.files.has(test.recordPath)).toBe(true);
  test.state.process = "gone";
  await test.manager().install(test.manifest);
  expect(test.files.has(test.recordPath)).toBe(false);
  expect(test.state.loaded).toBe(true);
});

it("requires an explicit durable recovery port for an injected macOS manifest filesystem", async () => {
  const test = fixture();
  const { stopRecoveryFilesystem: _recovery, ...options } = test.options;
  await expect(createServiceManager(options).stop(test.manifest)).rejects.toThrow(/durab|recovery/iu);
  expect(test.calls.some(call => call[1] === "bootout")).toBe(false);
  expect(test.files.has(test.recordPath)).toBe(false);
});
