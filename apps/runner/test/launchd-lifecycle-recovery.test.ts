import { expect, it } from "vitest";
import { serviceCommand, uninstall } from "../src/cli/lifecycle.js";
import { createServiceManager, renderService, serviceLayout, serviceProfilePath } from "../src/service.js";
import type { ServiceManagerOptions } from "../src/services/contracts.js";
import type { RunnerProfile } from "../src/profile.js";

function fixture() {
  const manifest = renderService({ platform: "darwin", mode: "system", executionMode: "privileged_host" });
  const recordPath = `${manifest.path}.purge-stop.json`;
  const files = new Map([[manifest.path, manifest.content]]);
  const calls: string[][] = [];
  const state = { loaded: true, process: "denied" as "denied" | "alive" | "gone", clock: 0, bootstrapFailures: 0, enableFailures: 0, bootoutFailures: 0 };
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
    if (args[0] === "bootout") {
      if (state.bootoutFailures-- > 0) return { exitCode: 1, stderr: "fixture bootout failure" };
      state.loaded = false;
      return { exitCode: 0 };
    }
    if (args[0] === "bootstrap") {
      if (state.bootstrapFailures-- > 0) return { exitCode: 5, stderr: "Service already loaded" };
      state.loaded = true;
      return { exitCode: 0 };
    }
    if (args[0] === "enable" && state.enableFailures-- > 0) return { exitCode: 1, stderr: "fixture enable failure" };
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

function firstInstallFixture() {
  const test = fixture();
  test.files.delete(test.manifest.path);
  test.state.loaded = false;
  test.state.enableFailures = 1;
  const before: RunnerProfile = { version: 1, server_url: "wss://fixture.example/runner/connect", runner_id: "fixture-runner",
    token: "fixture-token", management_mode: "central", execution_mode: "dedicated_user", workspaces: [] };
  let profile = before;
  const provisionedModes: string[] = [];
  const store = { filePath: serviceProfilePath(serviceLayout({ platform: "darwin", mode: "system" })), load: async () => profile,
    save: async (value: RunnerProfile) => { profile = value; }, remove: async () => undefined, assertServiceOwnership: async () => undefined };
  const dependencies = { servicePlatform: "darwin" as const, serviceManager: test.manager(), serviceFilesystem: test.filesystem,
    serviceProvisioner: { platform: "darwin" as const, provision: async (candidate: ReturnType<typeof renderService>) => {
      provisionedModes.push(candidate.executionMode);
      return { identity: "root", profileSecured: true };
    } }, isAdministrator: () => true };
  const install = () => serviceCommand({ command: "install", json: true, values: { executionMode: "privileged_host", confirmPrivilegedHost: true }, passthrough: [] }, store, () => undefined, dependencies);
  const remove = () => uninstall({ command: "uninstall", json: true, values: {}, passthrough: [] }, store, () => undefined,
    { ...dependencies, serviceManager: test.manager() });
  return { ...test, store, dependencies, before, provisionedModes, profile: () => profile, install, remove };
}

it.each(["bootout", "process-probe"] as const)("keeps a first macOS install retryable when rollback fails at %s", async failure => {
  const test = firstInstallFixture();
  if (failure === "bootout") test.state.bootoutFailures = 1;
  const result = await test.install().then(() => undefined, error => error as Error);
  expect(result?.message).toContain("fixture enable failure");
  expect(result?.message).toContain("rollback incomplete");
  expect(result?.cause).toBeInstanceOf(Error);
  expect(test.files.get(test.manifest.path)).toBe(test.manifest.content);
  expect(test.profile()).toEqual({ ...test.before, execution_mode: "privileged_host" });
  expect(JSON.parse(test.files.get(test.recordPath)!)).toMatchObject({ pid: 4321 });
  expect(test.state.loaded).toBe(failure === "bootout");
  test.state.process = "gone";
  await test.remove();
  expect(test.files.has(test.manifest.path)).toBe(false);
  expect(test.files.has(test.recordPath)).toBe(false);
  expect(test.state.loaded).toBe(false);
  expect(test.calls.some(call => call[0] === "ps")).toBe(true);
});

it("restores the original profile after a first macOS install is confirmed stopped", async () => {
  const test = firstInstallFixture();
  test.state.process = "gone";
  await expect(test.install()).rejects.toThrow("fixture enable failure");
  expect(test.profile()).toEqual(test.before);
  expect(test.files.has(test.manifest.path)).toBe(false);
  expect(test.files.has(test.recordPath)).toBe(false);
  expect(test.state.loaded).toBe(false);
  expect(test.calls.filter(call => call[1] === "bootout")).toHaveLength(1);
});

it("retains a failed first user install when an injected adapter cannot prove prior native ownership", async () => {
  const test = firstInstallFixture();
  const calls: string[] = [];
  const serviceManager = { platform: "darwin" as const, mode: "user" as const,
    install: async () => { throw new Error("fixture install failure"); }, stop: async () => { calls.push("stop"); },
    restart: async () => { calls.push("restart"); }, uninstall: async () => { calls.push("uninstall"); } };
  const manifest = renderService({ platform: "darwin", mode: "user", profilePath: test.store.filePath });
  const result = await serviceCommand({ command: "install", json: true, values: { user: true }, passthrough: [] }, test.store, () => undefined,
    { ...test.dependencies, serviceManager }).then(() => undefined, error => error as Error);
  expect(result?.message).toContain("fixture install failure");
  expect(result?.message).toContain("rollback incomplete");
  expect(result?.cause).toBeInstanceOf(Error);
  expect(test.files.get(manifest.path)).toBe(manifest.content);
  expect(test.profile()).toEqual(test.before);
  expect(calls).toEqual([]);
});

function stoppedManagedFixture() {
  const test = firstInstallFixture();
  const previous = renderService({ platform: "darwin", mode: "system", profilePath: test.store.filePath, executionMode: "dedicated_user" });
  test.files.set(previous.path, previous.content);
  return { ...test, previous };
}

it.each(["bootout", "process-probe"] as const)("preserves a newly active mode when a stopped managed macOS install cannot roll back at %s", async failure => {
  const test = stoppedManagedFixture();
  if (failure === "bootout") test.state.bootoutFailures = 2;
  const result = await test.install().then(() => undefined, error => error as Error);
  expect(test.files.get(test.manifest.path)).toBe(test.manifest.content);
  expect(test.profile()).toEqual({ ...test.before, execution_mode: "privileged_host" });
  expect(test.provisionedModes).toEqual(["privileged_host"]);
  expect(result?.message).toContain("fixture enable failure");
  expect(result?.message).toContain("rollback incomplete");
  expect(result?.cause).toBeInstanceOf(Error);
  expect(JSON.parse(test.files.get(test.recordPath)!)).toMatchObject({ pid: 4321 });
  test.state.bootoutFailures = 0;
  test.state.process = "gone";
  await test.remove();
  expect(test.files.has(test.manifest.path)).toBe(false);
  expect(test.files.has(test.recordPath)).toBe(false);
  expect(test.state.loaded).toBe(false);
});

it("restores a previously unloaded macOS manifest and profile without starting the old service", async () => {
  const test = stoppedManagedFixture();
  test.state.process = "gone";
  await expect(test.install()).rejects.toThrow("fixture enable failure");
  expect(test.profile()).toEqual(test.before);
  expect(test.provisionedModes).toEqual(["privileged_host", "dedicated_user"]);
  expect(test.files.get(test.manifest.path)).toBe(test.previous.content);
  expect(test.files.has(test.recordPath)).toBe(false);
  expect(test.state.loaded).toBe(false);
  expect(test.calls.filter(call => call[1] === "bootstrap")).toHaveLength(1);
  expect(test.calls.filter(call => call[1] === "bootout")).toHaveLength(1);
});

it("does not start a previously unloaded macOS service while rolling back a failed bootstrap", async () => {
  const test = stoppedManagedFixture();
  test.state.bootstrapFailures = 1;
  test.state.enableFailures = 0;
  test.state.process = "gone";
  await expect(test.install()).rejects.toThrow("Service already loaded");
  expect(test.profile()).toEqual(test.before);
  expect(test.files.get(test.manifest.path)).toBe(test.previous.content);
  expect(test.state.loaded).toBe(false);
  expect(test.calls.filter(call => call[1] === "bootstrap")).toHaveLength(1);
  expect(test.calls.some(call => call[1] === "bootout")).toBe(false);
});
