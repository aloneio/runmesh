import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { ProfileStore } from "../src/profile.js";
import { createServiceProvisioner, hashContent, isManagedService, renderService, type ServiceManifest, type ServiceManifestFilesystem } from "../src/service.js";
import { ensureManagedUserLaunch } from "../src/services/user-launch.js";

const connection = vi.hoisted(() => ({ constructed: vi.fn(), started: vi.fn(async () => undefined) }));
vi.mock("../src/connection.js", () => ({
  RunnerConnection: class {
    constructor(options: unknown) { connection.constructed(options); }
    start = connection.started;
    stop(): void {}
    disconnectForTest(): void {}
  },
}));
afterEach(() => { vi.clearAllMocks(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runner-user-service-"));
  const store = new ProfileStore({ baseDir: join(root, "profile with spaces") });
  // A valid copied profile retains its earlier machine-service mode. The
  // user-service invocation must select its own mode without rewriting it.
  await store.save({ version: 1, server_url: "wss://runner.example.test/runner/connect", runner_id: "user-mode-runner",
    token: "user-mode-fixture-token", management_mode: "central", execution_mode: "privileged_host", workspaces: [] });
  return { root, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

it.each(["linux", "darwin", "win32"] as const)("marks the %s user service launch as a user invocation", platform => {
  expect(renderService({ platform, mode: "user" }).content).toContain("--user");
  expect(renderService({ platform, mode: "system" }).content).not.toContain("--user");
});

it("keeps the public user install command and generated service execution mode aligned", async () => {
  const test = await fixture();
  const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const contents = new Map<string, string>();
  const filesystem: ServiceManifestFilesystem = {
    read: async path => contents.get(path),
    write: async (path, content) => { contents.set(path, content); },
    remove: async path => { contents.delete(path); },
  };
  let installed: ServiceManifest | undefined;
  const manager = { platform, mode: "user" as const,
    install: async (manifest: ServiceManifest) => { installed = manifest; },
    stop: async () => undefined, restart: async () => undefined, uninstall: async () => undefined,
    status: async () => ({ installed: installed !== undefined, active: installed !== undefined, reliable: true, identity: "fixture-user" }),
  };
  try {
    await runCli(["install", "--user", "--json"], { store: test.store, stdout: () => undefined,
      servicePlatform: platform, serviceFilesystem: filesystem, serviceManager: manager,
      serviceProvisioner: createServiceProvisioner({ platform }) });
    expect(installed).toMatchObject({ mode: "user", executionMode: "dedicated_user" });
    expect(installed?.content).toContain("--user");
    await expect(test.store.load()).resolves.toMatchObject({ execution_mode: "privileged_host" });
  } finally { await test.cleanup(); }
});

it.each([true, false])("applies the public start command's user flag (%s) before constructing the connection", async user => {
  const test = await fixture();
  const signals = ["SIGINT", "SIGTERM", "SIGUSR1"] as const;
  const listeners = new Map(signals.map(signal => [signal, process.listeners(signal)]));
  try {
    await runCli(["start", ...(user ? ["--user"] : []), "--profile", test.store.filePath, "--state-dir", join(test.root, "state")],
      { store: test.store, stdout: () => undefined, stderr: () => undefined });
    expect(connection.constructed).toHaveBeenCalledWith(expect.objectContaining({ executionMode: user ? "dedicated_user" : "privileged_host" }));
    expect(connection.started).toHaveBeenCalledOnce();
    await expect(test.store.load()).resolves.toMatchObject({ execution_mode: "privileged_host" });
  } finally {
    for (const signal of signals) for (const listener of process.listeners(signal)) {
      if (!listeners.get(signal)?.includes(listener)) process.removeListener(signal, listener);
    }
    await test.cleanup();
  }
});

it("keeps custom system command arguments from overriding the selected service mode", () => {
  expect(() => renderService({ platform: "linux", mode: "system", executionMode: "privileged_host",
    command: "/opt/runmesh/current/bin/runmesh start --user" })).toThrow("service command cannot override --user");
});

it.each(["linux", "darwin", "win32"] as const)("refreshes an existing %s user launch while preserving its custom settings", async platform => {
  const test = await fixture();
  const executable = platform === "win32" ? "C:\\Custom$&Runner\\runmesh.cmd" : "/srv/custom-$&-runner/bin/runmesh";
  const original = renderService({ platform, mode: "user", profilePath: test.store.filePath,
    command: `${executable} start --json --max-concurrent-jobs 2` });
  // Model the exact earlier renderer's missing flag with an intact ownership
  // marker, rather than inventing a malformed/unmanaged service definition.
  const originalBody = original.content.slice(original.content.indexOf("\n") + 1)
    .replace("<string>--user</string>", "").replace(" --user", "");
  const marker = platform === "linux" ? `# runmesh-runner-managed:${hashContent(originalBody)}\n` : `<!-- runmesh-runner-managed:${hashContent(originalBody)} -->\n`;
  const previous = `${marker}${originalBody}`;
  expect(isManagedService(previous)).toBe(true);
  const contents = new Map([[original.path, previous]]);
  const filesystem: ServiceManifestFilesystem = {
    read: async path => contents.get(path),
    write: async (path, content) => { contents.set(path, content); },
    remove: async path => { contents.delete(path); },
  };
  const installed: ServiceManifest[] = [];
  const restart = vi.fn(async () => undefined);
  const manager = { platform, mode: "user" as const,
    install: async (manifest: ServiceManifest) => { installed.push(manifest); },
    stop: async () => undefined, restart, uninstall: async () => undefined,
    // systemctl --user can report an empty User= because the manager already
    // runs as the current user; this is not a host-identity migration.
    status: async () => ({ installed: true, active: true, reliable: true }),
  };
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await runCli(["install", "--user", "--json"], { store: test.store, stdout: () => undefined,
        servicePlatform: platform, serviceFilesystem: filesystem, serviceManager: manager,
        serviceProvisioner: createServiceProvisioner({ platform }) });
    }
    expect(installed).toHaveLength(2);
    expect(installed[0]?.content).toBe(original.content);
    expect(installed[1]?.content).toBe(original.content);
    expect(restart).toHaveBeenCalledOnce();
    await expect(test.store.load()).resolves.toMatchObject({ execution_mode: "privileged_host" });
  } finally { await test.cleanup(); }
});

it("preserves CRLF and rejects unknown launch structures when refreshing a user definition", () => {
  const current = renderService({ platform: "linux", mode: "user", executablePath: "/srv/Runner With Spaces/runmesh" });
  const body = current.content.slice(current.content.indexOf("\n") + 1).replaceAll("\n", "\r\n");
  const missingFlag = body.replace(" --user", "");
  const previous = { ...current, hash: hashContent(missingFlag), content: `# runmesh-runner-managed:${hashContent(missingFlag)}\r\n${missingFlag}` };
  const updated = ensureManagedUserLaunch(previous);
  expect(updated.content).toBe(`# runmesh-runner-managed:${hashContent(body)}\r\n${body}`);
  expect(isManagedService(updated.content)).toBe(true);
  const unknown = missingFlag.replace(" start ", " custom-command ");
  expect(() => ensureManagedUserLaunch({ ...previous, content: `# runmesh-runner-managed:${hashContent(unknown)}\r\n${unknown}` }))
    .toThrow("managed user service launch must contain one Runner start command");
});
