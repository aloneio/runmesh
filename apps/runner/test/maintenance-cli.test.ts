import { expect, it, vi } from "vitest";
import { runMaintenanceCli } from "../src/maintenance-cli.js";
import { RUNNER_VERSION } from "../src/version.js";
import type { ProfileStore } from "../src/profile.js";

it("exposes the maintenance package identity and only its dedicated command surface", async () => {
  const output: string[] = [];
  const store = { load: async () => { throw new Error("help and version must not read a Runner profile"); } } as unknown as ProfileStore;
  await runMaintenanceCli(["--help"], { store, stdout: line => output.push(line) });
  expect(output[0]).toContain("Runmesh maintenance");
  expect(output[0]).toContain("maintenance-agent|install|migrate|stop|restart|uninstall");
  await runMaintenanceCli(["--version"], { store, stdout: line => output.push(line) });
  expect(output[1]).toBe(RUNNER_VERSION);
});

it.each(["start", "enroll", "doctor", "status", "workspace", "env", ""])("rejects the ordinary Runner command %s before dispatch", async command => {
  const startRunner = vi.fn(async () => undefined);
  const startMaintenanceAgent = vi.fn(async () => undefined);
  await expect(runMaintenanceCli(command ? [command] : [], { startRunner, startMaintenanceAgent })).rejects.toThrow("Runmesh maintenance");
  expect(startRunner).not.toHaveBeenCalled(); expect(startMaintenanceAgent).not.toHaveBeenCalled();
});

it("dispatches maintenance-agent directly without loading the Runner execution path", async () => {
  const startMaintenanceAgent = vi.fn(async () => undefined);
  await runMaintenanceCli(["maintenance-agent", "--profile", "/home/fixture/profile.json", "--install-root", "/home/fixture/runmesh", "--user"], { servicePlatform: "linux", startMaintenanceAgent });
  expect(startMaintenanceAgent).toHaveBeenCalledExactlyOnceWith({ profilePath: "/home/fixture/profile.json", installRoot: "/home/fixture/runmesh", mode: "user", platform: "linux" });
});

it("rejects incomplete maintenance arguments before starting the host agent", async () => {
  const startMaintenanceAgent = vi.fn(async () => undefined); const stderr = vi.fn();
  await expect(runMaintenanceCli(["maintenance-agent"], { startMaintenanceAgent, stderr })).rejects.toThrow("--profilePath is required");
  expect(startMaintenanceAgent).not.toHaveBeenCalled(); expect(stderr).toHaveBeenCalledWith("--profilePath is required");
});
