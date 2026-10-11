import { expect, it } from "vitest";
import { serviceCommand, uninstall } from "../src/cli/lifecycle.js";
import { runMaintenanceCli } from "../src/maintenance-cli.js";
import type { MaintenanceCliDependencies, ParsedCommand, ServiceProfilePort } from "../src/cli/contracts.js";
import type { RunnerProfile } from "../src/profile.js";
import { createServiceManager, renderService, serviceLayout, serviceProfilePath } from "../src/service.js";
import type { MaintenanceManagerOptions } from "../src/updates/manager-install.js";

function fixture() {
  const layout = serviceLayout({ platform: "linux", mode: "system" });
  const profile: RunnerProfile = { version: 1, server_url: "wss://runner.example.test/runner/connect", runner_id: "update-fixture", token: "update-fixture-token", management_mode: "central", execution_mode: "dedicated_user", workspaces: [] };
  const store = { filePath: serviceProfilePath(layout), load: async () => profile, save: async () => undefined,
    assertServiceOwnership: async () => undefined, remove: async () => undefined } satisfies ServiceProfilePort;
  const manifest = renderService({ platform: "linux", mode: "system", profilePath: store.filePath });
  const contents = new Map([[manifest.path, manifest.content]]);
  const calls: string[] = [];
  const maintenanceCalls: MaintenanceManagerOptions[] = [];
  const dependencies: MaintenanceCliDependencies = {
    isAdministrator: () => true,
    servicePlatform: "linux",
    serviceFilesystem: { read: async path => contents.get(path), write: async (path, content) => { contents.set(path, content); }, remove: async path => { calls.push("remove-runner-manifest"); contents.delete(path); } },
    serviceManager: { platform: "linux", mode: "system", install: async () => { calls.push("install-runner"); },
      stop: async () => { calls.push("stop-runner"); }, restart: async () => { calls.push("restart-runner"); },
      uninstall: async () => { calls.push("uninstall-runner"); }, status: async () => ({ installed: true, registered: true, active: true, reliable: true, identity: "runmesh" }) },
    serviceProvisioner: { platform: "linux", provision: async () => ({ identity: "runmesh", profileSecured: true }) },
    maintenanceManager: { install: async options => { calls.push("install-manager"); maintenanceCalls.push(options); },
      uninstall: async options => { calls.push("uninstall-manager"); maintenanceCalls.push(options); } },
  };
  return { layout, store, dependencies, calls, maintenanceCalls, contents, manifest };
}
const command = (name: string, values: ParsedCommand["values"] = {}): ParsedCommand => ({ command: name, json: true, values, passthrough: [] });

it("registers the independent manager after a successful existing Runner install", async () => {
  const test = fixture();
  const reports: string[] = [];
  await runMaintenanceCli(["install", "--json"], { ...test.dependencies, store: test.store, stdout: value => reports.push(value),
    maintenanceManager: { ...test.dependencies.maintenanceManager!, install: async options => { await test.dependencies.maintenanceManager!.install(options); return { enabled: true }; } } });
  expect(test.calls).toEqual(["install-runner", "install-manager"]);
  expect(test.maintenanceCalls[0]).toEqual({ platform: "linux", mode: "system", installRoot: "/opt/runmesh", profilePath: "/etc/runmesh/profile.json" });
  expect(test.contents.get(test.manifest.path)).toBe(test.manifest.content);
  expect(JSON.parse(reports[0]!)).toMatchObject({ remote_version_management: "available" });
});

it("reports manual maintenance without failing a custom service install", async () => {
  const test = fixture();
  const reports: string[] = [];
  await serviceCommand(command("install"), test.store, value => reports.push(value), { ...test.dependencies,
    maintenanceManager: { install: async () => ({ enabled: false, reason: "custom_service_layout" }), uninstall: async () => undefined } });
  expect(test.calls).toEqual(["install-runner"]);
  expect(JSON.parse(reports[0]!)).toMatchObject({ remote_version_management: "manual", remote_version_management_reason: "custom_service_layout" });
});

it("removes the independent manager before removing the Runner service", async () => {
  const test = fixture();
  await runMaintenanceCli(["uninstall", "--json"], { ...test.dependencies, store: test.store, stdout: () => undefined });
  expect(test.calls).toEqual(["uninstall-manager", "uninstall-runner", "remove-runner-manifest"]);
  expect(test.maintenanceCalls[0]?.preservePackage).toBe(true);
});

it.each(["stop", "restart"] as const)("dispatches %s through the independent maintenance CLI", async action => {
  const test = fixture();
  await runMaintenanceCli([action, "--json"], { ...test.dependencies, store: test.store, stdout: () => undefined });
  expect(test.calls).toEqual([`${action}-runner`]);
});

it("dispatches an explicit service migration through the independent maintenance CLI", async () => {
  const test = fixture();
  await runMaintenanceCli(["migrate", "--execution-mode", "dedicated_user", "--json"], { ...test.dependencies, store: test.store, stdout: () => undefined });
  expect(test.calls).toEqual(["install-runner", "install-manager"]);
});

it("does not purge when the independent manager still needs recovery", async () => {
  const test = fixture();
  let purged = false;
  await expect(uninstall(command("uninstall", { purge: true, yes: true }), test.store, () => undefined, {
    ...test.dependencies,
    maintenanceManager: { install: async () => undefined, uninstall: async () => { throw new Error("maintenance is unfinished"); } },
    purgeInstallation: async options => { await options?.beforeServiceStop?.(); purged = true; throw new Error("unexpected purge"); },
  })).rejects.toThrow("maintenance is unfinished");
  expect(purged).toBe(false);
  expect(test.contents.get(test.manifest.path)).toBe(test.manifest.content);
});

it("keeps the manager registered when complete purge reports a preflight failure", async () => {
  const test = fixture();
  await expect(uninstall(command("uninstall", { purge: true, yes: true }), test.store, () => undefined, {
    ...test.dependencies,
    purgeInstallation: async () => ({ action: "uninstall", purged: false, removed: [], absent: [], failures: [{ path: "/var/lib/runmesh", reason: "workspace retained" }], preserved: ["project workspaces"] }),
  })).rejects.toThrow("uninstall incomplete");
  expect(test.calls).toEqual([]);
  expect(test.maintenanceCalls).toEqual([]);
});

it("keeps the independent CLI available when cleanup fails after preflight", async () => {
  const test = fixture();
  await expect(uninstall(command("uninstall", { purge: true, yes: true }), test.store, () => undefined, {
    ...test.dependencies,
    purgeInstallation: async options => {
      await options?.beforeServiceStop?.();
      return { action: "uninstall", purged: false, removed: [], absent: [], failures: [{ path: "/var/log/runmesh", reason: "removal failed" }], preserved: ["project workspaces"] };
    },
  })).rejects.toThrow("uninstall incomplete");
  expect(test.calls).toEqual(["uninstall-manager"]);
  expect(test.maintenanceCalls[0]?.preservePackage).toBe(true);
});

it.each(["enabled", "disabled", "disable-failure"] as const)("restores an active Linux service's %s state after maintenance installation fails", async initial => {
  const test = fixture();
  const state = { enabled: initial === "enabled", active: true, failDisable: initial === "disable-failure", failMaintenance: true };
  const calls: string[][] = [];
  const serviceManager = createServiceManager({ platform: "linux", mode: "system", filesystem: test.dependencies.serviceFilesystem!, executor: {
    execute: async (file, args) => {
      expect(file).toBe("systemctl"); calls.push([...args]);
      if (args[0] === "is-enabled") return { exitCode: state.enabled ? 0 : 1, stdout: state.enabled ? "enabled\n" : "disabled\n" };
      if (args[0] === "is-active") return { exitCode: state.active ? 0 : 3 };
      if (args[0] === "show") return { exitCode: 0, stdout: "runmesh\n" };
      if (args[0] === "enable") { state.enabled = true; state.active = true; return { exitCode: 0 }; }
      if (args[0] === "disable") {
        if (state.failDisable) return { exitCode: 1, stderr: "fixture disable failure" };
        state.enabled = false; if (args.includes("--now")) state.active = false; return { exitCode: 0 };
      }
      if (args[0] === "restart") { state.active = true; return { exitCode: 0 }; }
      if (args[0] === "stop") { state.active = false; return { exitCode: 0 }; }
      if (args[0] === "daemon-reload") return { exitCode: 0 };
      throw new Error(`unexpected systemctl command: ${args.join(" ")}`);
    },
  } });
  const dependencies = { ...test.dependencies, serviceManager,
    maintenanceManager: { install: async () => { if (state.failMaintenance) throw new Error("fixture maintenance failure"); }, uninstall: async () => undefined } };
  const install = () => serviceCommand(command("install", { executablePath: "/fixture/new/bin/runmesh" }), test.store, () => undefined, dependencies);
  const result = await install().then(() => undefined, error => error as Error);
  expect(result?.message).toContain("fixture maintenance failure");
  if (initial === "disable-failure") {
    expect(result?.message).toContain("rollback incomplete");
    expect(result?.message).toContain("fixture disable failure");
    expect(result?.cause).toBeInstanceOf(Error);
  } else expect(state.enabled).toBe(initial === "enabled");
  expect(state.active).toBe(true);
  expect(test.contents.get(test.manifest.path)).toBe(test.manifest.content);
  expect(calls.some(args => args.includes("--now") && args[0] === "disable")).toBe(false);
  state.failDisable = false; state.failMaintenance = false;
  await install();
  expect(state).toMatchObject({ enabled: true, active: true });
  await uninstall(command("uninstall"), test.store, () => undefined, dependencies);
  expect(state).toMatchObject({ enabled: false, active: false });
  expect(test.contents.has(test.manifest.path)).toBe(false);
});

it.each(["profile", "manifest", "both", "stop"] as const)("keeps a failed migration retryable when restoring its %s contract fails", async failure => {
  const test = fixture();
  const before = await test.store.load();
  let profile = before;
  const originalFailure = new Error("fixture maintenance failure");
  const state = { active: true, enabled: true, definition: test.manifest.content, fail: true, rollingBack: false };
  const trace: string[] = [];
  const store: ServiceProfilePort = { ...test.store, load: async () => profile, save: async value => {
    trace.push(`save:${value.execution_mode}`);
    if (state.fail && state.rollingBack && value.execution_mode === "dedicated_user" && (failure === "profile" || failure === "both")) throw new Error("fixture profile restore failure");
    profile = value;
  } };
  const filesystem = { ...test.dependencies.serviceFilesystem!, write: async (path: string, value: string) => {
    trace.push(`write:${value === test.manifest.content ? "previous" : "candidate"}`);
    if (state.fail && state.rollingBack && value === test.manifest.content && (failure === "manifest" || failure === "both")) throw new Error("fixture manifest restore failure");
    test.contents.set(path, value);
  } };
  const serviceManager = createServiceManager({ platform: "linux", mode: "system", filesystem, executor: { execute: async (file, args) => {
    expect(file).toBe("systemctl");
    const operation = args[0]; trace.push(`native:${operation}`);
    if (operation === "daemon-reload") { state.definition = test.contents.get(test.manifest.path)!; return { exitCode: 0 }; }
    if (operation === "is-enabled") return { exitCode: state.enabled ? 0 : 1, stdout: state.enabled ? "enabled\n" : "disabled\n" };
    if (operation === "is-active") return { exitCode: state.active ? 0 : 3 };
    if (operation === "show") return { exitCode: 0, stdout: state.definition.includes("User=runmesh") ? "runmesh\n" : "root\n" };
    if (operation === "stop") {
      if (state.fail && state.rollingBack && failure === "stop") return { exitCode: 1, stderr: "fixture stop failure" };
      state.active = false; return { exitCode: 0 };
    }
    if (operation === "enable") { state.enabled = true; state.active = true; return { exitCode: 0 }; }
    if (operation === "restart") { state.active = true; return { exitCode: 0 }; }
    if (operation === "disable") { state.enabled = false; if (args.includes("--now")) state.active = false; return { exitCode: 0 }; }
    throw new Error(`unexpected fixture command: ${args.join(" ")}`);
  } } });
  const dependencies = { ...test.dependencies, serviceFilesystem: filesystem, serviceManager,
    serviceProvisioner: { platform: "linux" as const, provision: async (manifest: ReturnType<typeof renderService>) => {
      trace.push(`provision:${manifest.executionMode}`);
      return { identity: manifest.executionMode === "dedicated_user" ? "runmesh" : "root", profileSecured: true };
    } }, maintenanceManager: { install: async () => {
      if (state.fail) { state.rollingBack = true; trace.push("maintenance-failed"); throw originalFailure; }
    }, uninstall: async () => undefined } };
  const migrate = () => serviceCommand(command("migrate", { executionMode: "privileged_host", confirmPrivilegedHost: true }), store, () => undefined, dependencies);
  const result = await migrate().then(() => undefined, error => error as Error);
  expect(result?.message).toContain("fixture maintenance failure");
  expect(result?.message).toContain("rollback incomplete");
  expect(result?.cause).toBe(originalFailure);
  const rollback = trace.slice(trace.indexOf("maintenance-failed") + 1);
  expect(rollback).toContain("native:stop");
  expect(rollback).not.toContain("native:enable");
  expect(rollback).not.toContain("native:restart");
  expect(test.contents.has(test.manifest.path)).toBe(true);
  if (failure === "stop") {
    expect(state.active).toBe(true);
    expect(profile.execution_mode).toBe("privileged_host");
    expect(test.contents.get(test.manifest.path)).not.toBe(test.manifest.content);
    expect(rollback.some(call => call.startsWith("save:") || call.startsWith("write:") || call.startsWith("provision:"))).toBe(false);
  } else expect(state.active).toBe(false);
  state.fail = false;
  await migrate();
  expect(state.active).toBe(true);
  expect(profile.execution_mode).toBe("privileged_host");
  await uninstall(command("uninstall"), store, () => undefined, dependencies);
  expect(state.active).toBe(false);
  expect(test.contents.has(test.manifest.path)).toBe(false);
});

it.each([false, true])("restores a disabled Windows task after failed install while preserving active=%s", async active => {
  const layout = serviceLayout({ platform: "win32", mode: "system" });
  const profile: RunnerProfile = { version: 1, server_url: "wss://fixture.invalid/runner/connect", runner_id: "fixture-runner", token: "fixture-only-token", management_mode: "central", execution_mode: "dedicated_user", workspaces: [] };
  const store: ServiceProfilePort = { filePath: serviceProfilePath(layout), load: async () => profile, save: async () => undefined, remove: async () => undefined, assertServiceOwnership: async () => undefined };
  const manifest = renderService({ platform: "win32", mode: "system", profilePath: store.filePath });
  const contents = new Map([[manifest.path, manifest.content]]);
  const state = { registered: true, enabled: false, active, definition: manifest.content, failMaintenance: true };
  const calls: string[] = [];
  const filesystem = { read: async (path: string) => contents.get(path), write: async (path: string, content: string) => { contents.set(path, content); }, remove: async (path: string) => { contents.delete(path); } };
  const serviceManager = createServiceManager({ platform: "win32", mode: "system", filesystem, executor: { execute: async (file, args) => {
    if (file === "powershell.exe") {
      if (args.at(-1)!.includes("Write-Output 'stopped'")) return { exitCode: state.active ? 1 : 0, stdout: state.registered ? "stopped" : "absent" };
      return { exitCode: 0, stdout: JSON.stringify(state.registered ? { found: true, enabled: state.enabled, state: state.active ? 4 : state.enabled ? 3 : 1, identity: "NT AUTHORITY\\LOCAL SERVICE" } : { found: false, absent: true }) };
    }
    expect(file).toBe("schtasks"); calls.push(args.join(" "));
    if (args[0] === "/Query") return { exitCode: state.registered ? 0 : 1, ...(state.registered ? {} : { stderr: "ERROR: The system cannot find the file specified." }) };
    if (args[0] === "/Create") { state.definition = contents.get(manifest.path)!; state.registered = true; state.enabled = true; return { exitCode: 0 }; }
    if (args[0] === "/Run") { state.active = true; return { exitCode: 0 }; }
    if (args[0] === "/End") { state.active = false; return { exitCode: 0 }; }
    if (args[0] === "/Delete") { state.registered = false; return { exitCode: 0 }; }
    if (args[0] === "/Change" && args.includes("/DISABLE")) { state.enabled = false; return { exitCode: 0 }; }
    throw new Error(`unexpected fixture command: ${args.join(" ")}`);
  } } });
  const dependencies = { servicePlatform: "win32" as const, isAdministrator: () => true, serviceManager, serviceFilesystem: filesystem,
    serviceProvisioner: { platform: "win32" as const, provision: async () => ({ identity: "NT AUTHORITY\\LOCAL SERVICE", profileSecured: true }) },
    maintenanceManager: { install: async () => { if (state.failMaintenance) throw new Error("fixture maintenance failure"); }, uninstall: async () => undefined } };
  const install = () => serviceCommand(command("install", { executablePath: "C:\\fixture\\new\\runmesh.cmd" }), store, () => undefined, dependencies);
  const result = await install().then(() => undefined, error => error as Error);
  expect(result?.message).toBe("fixture maintenance failure");
  expect(contents.get(manifest.path)).toBe(manifest.content);
  expect(state).toMatchObject({ enabled: false, active, definition: manifest.content });
  expect(calls.some(call => call.startsWith("/Change") && call.includes("/DISABLE"))).toBe(true);
  state.failMaintenance = false;
  await install();
  expect(state).toMatchObject({ enabled: true, active: true });
  await uninstall(command("uninstall"), store, () => undefined, dependencies);
  expect(state).toMatchObject({ registered: false, active: false });
  expect(contents.has(manifest.path)).toBe(false);
});
