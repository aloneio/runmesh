import { expect, it, vi } from "vitest";
import { runMaintenanceCli } from "../src/maintenance-cli.js";
import { isCliErrorReported } from "../src/cli/reporting.js";
import { RUNNER_VERSION } from "../src/version.js";
import type { CliDependencies, MaintenanceCliDependencies, ServiceProfilePort } from "../src/cli/contracts.js";
import type { RunnerProfile } from "../src/profile.js";
import { renderService } from "../src/service.js";
import type { ManagerRefreshResult } from "../src/updates/manager-refresh.js";

it("exposes the maintenance package identity and only its dedicated command surface", async () => {
  const output: string[] = [];
  const unexpectedProfileAccess = () => { throw new Error("help and version must not access a Runner profile"); };
  const store: ServiceProfilePort = { get filePath() { return unexpectedProfileAccess(); }, load: unexpectedProfileAccess,
    save: unexpectedProfileAccess, remove: unexpectedProfileAccess, assertServiceOwnership: unexpectedProfileAccess };
  await runMaintenanceCli(["--help"], { store, stdout: line => output.push(line) });
  expect(output[0]).toContain("Runmesh maintenance");
  expect(output[0]).toContain("maintenance-agent|manager-refresh|install|migrate|stop|restart|uninstall");
  expect(output[0]).toContain("manager-refresh --profile <existing-profile> --install-root <root> --release-dir <signed-assets> [--user] [--json]");
  await runMaintenanceCli(["--version"], { store, stdout: line => output.push(line) });
  expect(output[1]).toBe(RUNNER_VERSION);
});

it.each(["start", "enroll", "doctor", "status", "workspace", "env", ""])("rejects the ordinary Runner command %s before dispatch", async command => {
  const startRunner = vi.fn(async () => undefined);
  const startMaintenanceAgent = vi.fn(async () => undefined);
  const dependencies: CliDependencies = { startRunner, startMaintenanceAgent };
  await expect(runMaintenanceCli(command ? [command] : [], dependencies)).rejects.toThrow("Runmesh maintenance");
  expect(startRunner).not.toHaveBeenCalled(); expect(startMaintenanceAgent).not.toHaveBeenCalled();
});

it("dispatches maintenance-agent directly without loading the Runner execution path", async () => {
  const startMaintenanceAgent = vi.fn(async () => undefined);
  await runMaintenanceCli(["maintenance-agent", "--profile", "/home/fixture/profile.json", "--install-root", "/home/fixture/runmesh", "--user"], { servicePlatform: "linux", startMaintenanceAgent });
  expect(startMaintenanceAgent).toHaveBeenCalledExactlyOnceWith({ profilePath: "/home/fixture/profile.json", installRoot: "/home/fixture/runmesh", mode: "user", platform: "linux" });
});

const refreshArgs = ["manager-refresh", "--profile", "/home/fixture/profile.json", "--install-root", "/home/fixture/runmesh", "--release-dir", "/home/fixture/release"];
const refreshed: ManagerRefreshResult = { action: "manager-refresh", manager_version: "0.1.9-dev.99", previous_manager_version: "0.1.8", runner_unchanged: true, restarted: true };

it.each([
  { user: false, json: false }, { user: false, json: true }, { user: true, json: false }, { user: true, json: true },
])("refreshes only the independent manager with user=$user and json=$json", async ({ user, json }) => {
  const refreshMaintenanceManager = vi.fn(async () => refreshed), output = vi.fn();
  const startMaintenanceAgent = vi.fn(async () => undefined);
  await runMaintenanceCli([...refreshArgs, ...(user ? ["--user"] : []), ...(json ? ["--json"] : [])], {
    servicePlatform: "linux", refreshMaintenanceManager, startMaintenanceAgent, stdout: output,
    get store() { throw new Error("manager refresh delegates existing profile validation to its own transaction"); },
  });
  expect(refreshMaintenanceManager).toHaveBeenCalledExactlyOnceWith({ profilePath: "/home/fixture/profile.json", installRoot: "/home/fixture/runmesh",
    releaseDirectory: "/home/fixture/release", mode: user ? "user" : "system", platform: "linux" });
  expect(startMaintenanceAgent).not.toHaveBeenCalled();
  expect(output).toHaveBeenCalledExactlyOnceWith(json ? JSON.stringify(refreshed) : `Maintenance manager version: ${refreshed.manager_version}`);
});

it.each(["--profile", "--install-root", "--release-dir"])("requires %s before refreshing the manager", async option => {
  const refreshMaintenanceManager = vi.fn(async () => refreshed);
  const index = refreshArgs.indexOf(option), argv = [...refreshArgs.slice(0, index), ...refreshArgs.slice(index + 2)];
  await expect(runMaintenanceCli(argv, { refreshMaintenanceManager })).rejects.toThrow(`${option} is required`);
  expect(refreshMaintenanceManager).not.toHaveBeenCalled();
});

it.each(["--profile", "--install-root", "--release-dir"])("requires a value for manager-refresh %s", async option => {
  const refreshMaintenanceManager = vi.fn(async () => refreshed);
  const index = refreshArgs.indexOf(option), without = [...refreshArgs.slice(0, index), ...refreshArgs.slice(index + 2)];
  for (const trailing of [[option], [option, ""], [option, "--json"]]) {
    await expect(runMaintenanceCli([...without, ...trailing], { refreshMaintenanceManager })).rejects.toThrow(`unknown or incomplete option: ${option}`);
  }
  expect(refreshMaintenanceManager).not.toHaveBeenCalled();
});

it.each(["--purge", "--yes", "--insecure-local", "--re-enroll", "--confirm-privileged-host", "--code-stdin", "--server", "--execution-mode", "--trust-key", "extra", "--"])("rejects the unrelated manager-refresh option %s before dispatch", async option => {
  const refreshMaintenanceManager = vi.fn(async () => refreshed);
  await expect(runMaintenanceCli([...refreshArgs, option], { refreshMaintenanceManager })).rejects.toThrow(`unknown or incomplete option: ${option}`);
  expect(refreshMaintenanceManager).not.toHaveBeenCalled();
});

it.each(["--profile", "--install-root", "--release-dir", "--user", "--json"])("rejects duplicate manager-refresh %s options", async option => {
  const refreshMaintenanceManager = vi.fn(async () => refreshed);
  const duplicate = option === "--user" || option === "--json" ? [option, option] : [option, "/another/path"];
  await expect(runMaintenanceCli([...refreshArgs, ...duplicate], { refreshMaintenanceManager })).rejects.toThrow(`duplicate option: ${option}`);
  expect(refreshMaintenanceManager).not.toHaveBeenCalled();
});

it.each(["install", "maintenance-agent"])("keeps --release-dir exclusive to manager-refresh instead of %s", async command => {
  const refreshMaintenanceManager = vi.fn(async () => refreshed), startMaintenanceAgent = vi.fn(async () => undefined);
  await expect(runMaintenanceCli([command, "--release-dir", "/home/fixture/release"], { refreshMaintenanceManager, startMaintenanceAgent })).rejects.toThrow("unknown or incomplete option: --release-dir");
  expect(refreshMaintenanceManager).not.toHaveBeenCalled(); expect(startMaintenanceAgent).not.toHaveBeenCalled();
});

it("reports manager refresh failure once and leaves success output empty", async () => {
  const failure = Object.freeze(new Error("manager refresh transaction failed")), stdout = vi.fn(), stderr = vi.fn();
  const refreshMaintenanceManager = vi.fn(async () => { throw failure; });
  const cause = await runMaintenanceCli(refreshArgs, { refreshMaintenanceManager, stdout, stderr }).catch(error => error);
  expect(cause).toBe(failure); expect(isCliErrorReported(cause)).toBe(true);
  expect(stderr).toHaveBeenCalledExactlyOnceWith(failure.message); expect(stdout).not.toHaveBeenCalled();
  expect(refreshMaintenanceManager).toHaveBeenCalledOnce();
});

it("retains a completed manager refresh when success output fails", async () => {
  const failure = new Error("refresh output unavailable"), refreshMaintenanceManager = vi.fn(async () => refreshed), stderr = vi.fn();
  await expect(runMaintenanceCli(refreshArgs, { refreshMaintenanceManager, stdout: () => { throw failure; }, stderr })).rejects.toBe(failure);
  expect(refreshMaintenanceManager).toHaveBeenCalledOnce(); expect(stderr).toHaveBeenCalledExactlyOnceWith(failure.message);
});

it("rejects incomplete maintenance arguments before starting the host agent", async () => {
  const startMaintenanceAgent = vi.fn(async () => undefined); const stderr = vi.fn();
  await expect(runMaintenanceCli(["maintenance-agent"], { startMaintenanceAgent, stderr })).rejects.toThrow("--profilePath is required");
  expect(startMaintenanceAgent).not.toHaveBeenCalled(); expect(stderr).toHaveBeenCalledWith("--profilePath is required");
});

it.each([Object.freeze(new Error("maintenance runtime failed")), "maintenance runtime failed"])("marks reported maintenance failures without suppressing runtime errors: %s", async failure => {
  const stderr = vi.fn();
  const cause = await runMaintenanceCli(["maintenance-agent", "--profile", "/home/fixture/profile.json", "--install-root", "/home/fixture/runmesh", "--user"], {
    servicePlatform: "linux", stderr, startMaintenanceAgent: async () => { throw failure; },
  }).catch(error => error);
  expect(stderr).toHaveBeenCalledExactlyOnceWith("maintenance runtime failed");
  expect(isCliErrorReported(cause)).toBe(true);
  if (failure instanceof Error) expect(cause).toBe(failure);
  else expect(cause).toMatchObject({ message: failure, cause: failure });
});

it("leaves failures unreported when the stderr handler fails", async () => {
  const writeFailure = new Error("stderr unavailable");
  const cause = await runMaintenanceCli(["maintenance-agent"], { stderr: () => { throw writeFailure; } }).catch(error => error);
  expect(cause).toBe(writeFailure);
  expect(isCliErrorReported(cause)).toBe(false);
});

it.each(["install", "migrate"] as const)("retains a completed %s when success reporting fails", async action => {
  const test = lifecycleFixture(action);
  const failure = new Error("success output unavailable");
  await expect(runMaintenanceCli(test.argv, { ...test.dependencies, stdout: () => { throw failure; } })).rejects.toBe(failure);
  expect(test.calls).toEqual(action === "install"
    ? ["install:privileged_host", "install-manager"]
    : ["install:privileged_host", "restart:privileged_host", "install-manager"]);
  expect(test.state).toMatchObject({ active: true, installed: true, mode: "privileged_host" });
  expect(await test.dependencies.store!.load()).toMatchObject({ execution_mode: "privileged_host" });
  expect(test.files.get(test.manifest.path)).toBe(test.manifest.content);
  expect(test.errors).toEqual([failure.message]);
});

it.each(["install", "migrate"] as const)("still rolls back %s when the native installation fails", async action => {
  const failure = new Error("native setup incomplete");
  const test = lifecycleFixture(action, failure);
  const output = vi.fn();
  await expect(runMaintenanceCli(test.argv, { ...test.dependencies, stdout: output })).rejects.toBe(failure);
  expect(output).not.toHaveBeenCalled();
  expect(test.calls).not.toContain("install-manager");
  expect(await test.dependencies.store!.load()).toEqual(test.before);
  if (action === "install") {
    expect(test.calls).toEqual(["install:privileged_host", "uninstall:privileged_host"]);
    expect(test.files.has(test.manifest.path)).toBe(false);
    expect(test.state).toMatchObject({ active: false, installed: false });
  } else {
    expect(test.calls).toEqual(["install:privileged_host", "stop:privileged_host", "install:dedicated_user", "restart:dedicated_user"]);
    expect(test.files.get(test.previous.path)).toBe(test.previous.content);
    expect(test.state).toMatchObject({ active: true, installed: true, mode: "dedicated_user" });
  }
});

function lifecycleFixture(action: "install" | "migrate", nativeFailure?: Error) {
  const before: RunnerProfile = { version: 1, server_url: "wss://fixture.example/runner/connect", runner_id: "output-fixture",
    token: "synthetic-output-fixture-token", management_mode: "central", execution_mode: "dedicated_user", workspaces: [] };
  let profile = before;
  const previous = renderService({ platform: "linux", mode: "system", executionMode: "dedicated_user" });
  const manifest = renderService({ platform: "linux", mode: "system", executionMode: "privileged_host" });
  const files = new Map(action === "install" ? [] : [[previous.path, previous.content]]);
  const state = { installed: action === "migrate", active: action === "migrate", mode: "dedicated_user" };
  const calls: string[] = [], errors: string[] = [];
  let pendingFailure = nativeFailure;
  const dependencies: MaintenanceCliDependencies = {
    store: { filePath: "/etc/runmesh/profile.json", load: async () => profile, save: async value => { profile = value; },
      remove: async () => undefined, assertServiceOwnership: async () => undefined },
    stderr: line => errors.push(line), isAdministrator: () => true, servicePlatform: "linux",
    serviceFilesystem: { read: async path => files.get(path), write: async (path, content) => { files.set(path, content); }, remove: async path => { files.delete(path); } },
    serviceProvisioner: { platform: "linux", provision: async candidate => ({ identity: candidate.executionMode === "privileged_host" ? "root" : "runmesh", profileSecured: true }) },
    serviceManager: { platform: "linux", mode: "system",
      status: async () => ({ installed: state.installed, registered: state.installed, active: state.active, reliable: true, identity: state.mode === "privileged_host" ? "root" : "runmesh" }),
      install: async candidate => {
        calls.push(`install:${candidate.executionMode}`); state.installed = true; state.active = true; state.mode = candidate.executionMode;
        if (pendingFailure !== undefined) { const error = pendingFailure; pendingFailure = undefined; throw error; }
      },
      restart: async candidate => { calls.push(`restart:${candidate.executionMode}`); state.active = true; state.mode = candidate.executionMode; },
      stop: async candidate => { calls.push(`stop:${candidate.executionMode}`); state.active = false; },
      uninstall: async candidate => { calls.push(`uninstall:${candidate.executionMode}`); state.active = false; state.installed = false; },
    },
    maintenanceManager: { install: async () => { calls.push("install-manager"); return { enabled: true }; }, uninstall: async () => { calls.push("uninstall-manager"); } },
  };
  return { argv: [action, "--execution-mode", "privileged_host", "--confirm-privileged-host", "--json"], before, previous, manifest, files, state, calls, errors, dependencies };
}
