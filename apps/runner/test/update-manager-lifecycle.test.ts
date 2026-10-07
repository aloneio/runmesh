import { expect, it } from "vitest";
import { serviceCommand, uninstall } from "../src/cli/lifecycle.js";
import { runMaintenanceCli } from "../src/maintenance-cli.js";
import type { MaintenanceCliDependencies, ParsedCommand, ServiceProfilePort } from "../src/cli/contracts.js";
import type { RunnerProfile } from "../src/profile.js";
import { renderService, serviceLayout, serviceProfilePath } from "../src/service.js";
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
    purgeInstallation: async () => { purged = true; throw new Error("unexpected purge"); },
  })).rejects.toThrow("maintenance is unfinished");
  expect(purged).toBe(false);
  expect(test.contents.get(test.manifest.path)).toBe(test.manifest.content);
});

it("keeps the independent CLI available when complete purge reports a cleanup failure", async () => {
  const test = fixture();
  await expect(uninstall(command("uninstall", { purge: true, yes: true }), test.store, () => undefined, {
    ...test.dependencies,
    purgeInstallation: async () => ({ action: "uninstall", purged: false, removed: [], absent: [], failures: [{ path: "/var/lib/runmesh", reason: "workspace retained" }], preserved: ["project workspaces"] }),
  })).rejects.toThrow("uninstall incomplete");
  expect(test.calls).toEqual(["uninstall-manager"]);
  expect(test.maintenanceCalls[0]?.preservePackage).toBe(true);
});
