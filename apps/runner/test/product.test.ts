import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, runEnrollCli, parseProductArgs } from "../src/cli.js";
import { RunnerConnection, classifyConnectionFailure } from "../src/connection.js";
import { RUNNER_VERSION } from "../src/version.js";
import { enrollRunner } from "../src/enrollment.js";
import { ProfileStore, defaultWorkspaceId } from "../src/profile.js";
import { createServiceManager, installServiceManifest, isManagedService, removeServiceManifest, renderService, serviceLayout, type ServiceManifestFilesystem } from "../src/service.js";

async function fixture(): Promise<{ root: string; store: ProfileStore; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "runner-product-"));
  await mkdir(join(root, "workspace"));
  return { root, store: new ProfileStore({ baseDir: join(root, "profile") }), cleanup: () => rm(root, { recursive: true, force: true }) };
}
const profile = (path: string) => ({ version: 1 as const, server_url: "wss://runner.example.test/runner/connect", runner_id: "runner-1", token: "0123456789abcdef", execution_mode: "dedicated_user" as const, workspaces: [{ id: "workspace", path, writable: true, shell: true }] });

describe("runner product profile and enrollment", () => {
  it("writes atomic private redacted profile data and suffixes workspace ids", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      const raw = await readFile(test.store.filePath, "utf8");
      expect(raw).toContain("0123456789abcdef");
      expect((await stat(test.store.filePath)).mode & 0o777).toBe(0o600);
      expect(defaultWorkspaceId("/tmp/workspace", [{ id: "workspace", path: "/tmp/a", writable: true, shell: true }])).toBe("workspace-2");
      const lines: string[] = [];
      await runCli(["status", "--json"], { store: test.store, stdout: (line) => lines.push(line) });
      expect(lines.join("\n")).toContain("[redacted]");
      expect(lines.join("\n")).not.toContain("0123456789abcdef");
    } finally { await test.cleanup(); }
  });
  it("posts one-time code with public information and saves a zero-workspace machine profile without outputting token", async () => {
    const test = await fixture();
    try {
      const calls: RequestInit[] = [];
      const result = await enrollRunner({ server: "https://example.test/runner/enroll", code: "a".repeat(43), cwd: join(test.root, "workspace"), store: test.store, fetch: async (_url, init) => { calls.push(init ?? {}); return new Response(JSON.stringify({ runner_id: "runner-1", server_url: "https://example.test/runner/connect", token: "fedcba9876543210" }), { status: 200 }); } });
      expect(calls).toHaveLength(1); expect(calls[0]?.body).toContain("enrollment_code");
      expect(result.profile).toMatchObject({ server_url: "wss://example.test/runner/connect", workspaces: [] });
    } finally { await test.cleanup(); }
  });
  it("re-enrollment replaces connection credentials without adding a workspace", async () => {
    const test = await fixture();
    try {
      const original = profile(join(test.root, "workspace"));
      await test.store.save(original);
      const result = await enrollRunner({ server: "https://example.test/runner/enroll", code: "a".repeat(43), reEnroll: true, cwd: join(test.root, "workspace"), store: test.store, fetch: async () => new Response(JSON.stringify({ runner_id: "runner-replaced", server_url: "https://example.test/runner/connect", token: "abcdef0123456789" }), { status: 200 }) });
      expect(result.profile).toMatchObject({ runner_id: "runner-replaced", token: "abcdef0123456789", workspaces: original.workspaces });
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "runner-replaced", workspaces: original.workspaces });
    } finally { await test.cleanup(); }
  });
  it("runs the real enrollment CLI with an isolated profile without outputting the token", async () => {
    const test = await fixture();
    try {
      const lines: string[] = []; const errors: string[] = [];
      await runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "a".repeat(43), "--cwd", join(test.root, "workspace"), "--json"], {
        store: test.store, stdout: (line) => lines.push(line), stderr: (line) => errors.push(line),
        fetch: async () => new Response(JSON.stringify({ runner_id: "runner-e2e", server_url: "https://example.test/runner/connect", token: "real-cli-token-must-not-print" }), { status: 200 }),
      });
      expect(lines.join("\n")).toContain("runner-e2e");
      expect(lines.join("\n")).toContain("workspace_count");
      expect(lines.join("\n")).not.toContain("real-cli-token-must-not-print");
      expect(errors).toEqual([]);
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "runner-e2e", token: "real-cli-token-must-not-print", workspaces: [] });
    } finally { await test.cleanup(); }
  });

  it("accepts a code from stdin without outputting the code or token", async () => {
    const test = await fixture();
    try {
      const code = "b".repeat(43); const lines: string[] = []; const errors: string[] = [];
      expect(parseProductArgs(["enroll", "--server", "https://example.test/runner/enroll", "--code-stdin"]).values).toMatchObject({ codeStdin: true });
      await runEnrollCli(["--server", "https://example.test/runner/enroll", "--code-stdin", "--json"], {
        store: test.store, stdout: (line) => lines.push(line), stderr: (line) => errors.push(line), readStdin: async () => ` ${code}\n`,
        fetch: async () => new Response(JSON.stringify({ runner_id: "stdin-runner", server_url: "https://example.test/runner/connect", token: "stdin-token-must-not-print" }), { status: 200 }),
      });
      expect(lines.join("\\n")).toContain("stdin-runner");
      expect(lines.join("\\n")).not.toContain(code); expect(lines.join("\\n")).not.toContain("stdin-token-must-not-print"); expect(errors).toEqual([]);
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "stdin-runner", token: "stdin-token-must-not-print" });
    } finally { await test.cleanup(); }
  });
  it("rejects empty, invalid, and conflicting stdin enrollment input", async () => {
    const test = await fixture();
    try {
      const error = () => undefined;
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code-stdin"], { store: test.store, stderr: error, readStdin: async () => "   ", fetch: async () => new Response() })).rejects.toThrow("--code-stdin requires");
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code-stdin", "--code", "a".repeat(43)], { store: test.store, stderr: error, readStdin: async () => "b".repeat(43), fetch: async () => new Response() })).rejects.toThrow("cannot be used together");
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code-stdin"], { store: test.store, stderr: error, readStdin: async () => "invalid code", fetch: async () => new Response() })).rejects.toThrow("one-time enrollment code");
    } finally { await test.cleanup(); }
  });

  it("removes a newly enrolled profile if the same CLI operation later fails", async () => {
    const test = await fixture();
    try {
      await expect(runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code-stdin", "--profile", test.store.filePath], {
        store: test.store, stderr: () => undefined, readStdin: async () => "c".repeat(43), afterEnroll: async () => { throw new Error("post-enrollment activation failed"); },
        fetch: async () => new Response(JSON.stringify({ runner_id: "rollback-runner", server_url: "https://example.test/runner/connect", token: "rollback-token-must-be-removed" }), { status: 200 }),
      })).rejects.toThrow("post-enrollment activation failed");
      await expect(test.store.load()).resolves.toBeUndefined();
    } finally { await test.cleanup(); }
  });

  it("rejects cleartext enrollment except explicit loopback development", async () => {
    const test = await fixture();
    try {
      await expect(enrollRunner({ server: "http://example.test/runner/enroll", code: "a".repeat(43), cwd: join(test.root, "workspace"), store: test.store, fetch: async () => new Response() })).rejects.toThrow("https:// is required");
      const result = await enrollRunner({ server: "http://127.0.0.1/runner/enroll", code: "a".repeat(43), insecureLocal: true, cwd: join(test.root, "workspace"), store: test.store, fetch: async () => new Response(JSON.stringify({ runner_id: "runner-1", server_url: "http://127.0.0.1/runner/connect", token: "fedcba9876543210" }), { status: 200 }) });
      expect(result.profile).toMatchObject({ runner_id: "runner-1", server_url: "ws://127.0.0.1/runner/connect", insecure_local: true });
      await expect(test.store.load()).resolves.toMatchObject({ insecure_local: true });
    } finally { await test.cleanup(); }
  });
});
describe("runner product CLI and service safety", () => {
  it("reports its installed package version instead of a hardcoded transport value", () => {
    expect(RUNNER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const connection = new RunnerConnection({ config: { server: "wss://runner.example.test/runner/connect", runnerId: "version-runner", token: "0123456789abcdef", workspaces: [] } });
    expect((connection as unknown as { metadata: { runner_version: string } }).metadata.runner_version).toBe(RUNNER_VERSION);
  });

  it("parses product CLI options and uses profile defaults for start", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      expect(parseProductArgs(["workspace", "add", "--path", ".", "--readonly", "--json"])).toMatchObject({ command: "workspace", json: true, values: { action: "add", path: ".", readonly: true } });
      let started: unknown;
      await runCli(["start"], { store: test.store, startRunner: async (config) => { started = config; } });
      expect(started).toMatchObject({ runnerId: "runner-1", workspaces: [{ workspaceId: "workspace", readonly: false, shell: true }] });
    } finally { await test.cleanup(); }
  });
  it("uses profile workspaces exactly, including a zero-workspace machine Runner", async () => {
    const test = await fixture();
    try {
      await test.store.save({ ...profile(join(test.root, "workspace")), workspaces: [] });
      let started: unknown;
      await runCli(["start"], { store: test.store, startRunner: async (config) => { started = config; } });
      expect(started).toMatchObject({ runnerId: "runner-1", workspaces: [] });
    } finally { await test.cleanup(); }
  });
  it("renders dedicated-user manifests and uses privileged host only by explicit mode", () => {
    const linux = renderService({ platform: "linux", mode: "system" });
    expect(serviceLayout({ platform: "linux", mode: "system" })).toMatchObject({ installRoot: "/opt/runmesh", configRoot: "/etc/runmesh", stateRoot: "/var/lib/runmesh", logRoot: "/var/log/runmesh", manifestPath: "/etc/systemd/system/runmesh-runner.service" });
    expect(linux).toMatchObject({ executionMode: "dedicated_user" });
    expect(serviceLayout({ platform: "linux", mode: "system" }).executablePath).toBe("/opt/runmesh/current/bin/coding-runner");
    expect(serviceLayout({ platform: "darwin", mode: "system" }).executablePath).toBe("/opt/runmesh/current/bin/coding-runner");
    expect(linux.content).toContain("User=runmesh");
    expect(linux.content).toContain("Group=runmesh");
    expect(linux.content).toContain("ExecStart=/opt/runmesh/current/bin/coding-runner start");
    expect(linux.content).toContain("RUNMESH_RUNNER_PROFILE=/etc/runmesh/profile.json");
    expect(linux.content).not.toContain("coding-runner start\n");
    const macos = renderService({ platform: "darwin", mode: "system" });
    expect(macos.content).toContain("<key>UserName</key><string>runmesh</string>");
    expect(macos.content).toContain("io.alone.runmesh.runner");
    const windows = renderService({ platform: "win32", mode: "system" });
    expect(windows.content).toContain("NT AUTHORITY\\LOCAL SERVICE");
    expect(windows.content).not.toContain("<UserId>SYSTEM</UserId>");
    const privileged = renderService({ platform: "win32", mode: "system", executionMode: "privileged_host" });
    expect(privileged.content).toContain("<UserId>SYSTEM</UserId>");
    expect(Buffer.from(windows.content, "utf8").toString("utf8")).toBe(windows.content);
  });
  it("requires explicit confirmation for privileged host services without breaking legacy profiles", async () => {
    const test = await fixture();
    try {
      const contents = new Map<string, string>();
      const filesystem: ServiceManifestFilesystem = { read: async (path) => contents.get(path), write: async (path, content) => { contents.set(path, content); }, remove: async (path) => { contents.delete(path); } };
      const manager = createServiceManager({ platform: "linux", mode: "system", executor: { execute: async () => ({ exitCode: 0 }) } });
      await test.store.save({ ...profile(join(test.root, "workspace")), execution_mode: "dedicated_user" });
      const serviceProvisioner = { platform: "linux" as const, provision: async () => ({ identity: "runmesh", profileSecured: true }) };
      await expect(runCli(["install", "--execution-mode", "privileged_host"], { store: test.store, stdout: () => undefined, stderr: () => undefined, servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, serviceProvisioner, isAdministrator: () => true })).rejects.toThrow("confirm-privileged-host");
      await runCli(["install", "--execution-mode", "privileged_host", "--confirm-privileged-host"], { store: test.store, stdout: () => undefined, stderr: () => undefined, servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, serviceProvisioner, isAdministrator: () => true });
      expect([...contents.values()][0]).not.toContain("User=runmesh");
      await test.store.save(profile(join(test.root, "workspace")));
      await expect(runCli(["install"], { store: test.store, stdout: () => undefined, stderr: () => undefined, servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, serviceProvisioner, isAdministrator: () => true })).resolves.toBeUndefined();
    } finally { await test.cleanup(); }
  });
  it("emits stable doctor JSON checks and only fails its exit seam for required failures", async () => {
    const test = await fixture();
    try {
      await test.store.save({ ...profile(join(test.root, "workspace")), execution_mode: "dedicated_user" });
      const content = renderService({ platform: "linux", mode: "system", profilePath: test.store.filePath, executionMode: "dedicated_user" }).content;
      const filesystem: ServiceManifestFilesystem = { read: async () => content, write: async () => undefined, remove: async () => undefined };
      const manager = {
        platform: "linux" as const, mode: "system" as const,
        install: async () => undefined, stop: async () => undefined, restart: async () => undefined, uninstall: async () => undefined,
        status: async () => ({ installed: true, active: true, identity: "runmesh" }),
      };
      const lines: string[] = []; const exitCodes: number[] = [];
      await runCli(["doctor", "--json"], {
        store: test.store, stdout: (line) => lines.push(line), servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager,
        discoverShellRuntime: async () => ({ kind: "bash", executable: "/bin/bash", buildInvocation: (command) => ({ file: "/bin/bash", args: ["-lc", command] }) }),
        environment: new (await import("../src/runtime.js")).EnvironmentInfoService({ probe: async (command) => command === "python3" || command === "python" || command === "docker" ? undefined : `${command} version` }),
        policyRevision: async () => ({ desired: 3, applied: 3 }), setExitCode: (code) => exitCodes.push(code),
      });
      const result = JSON.parse(lines[0] ?? "{}") as { ok: boolean; checks: Array<{ name: string; status: string }> };
      expect(result.ok).toBe(true);
      expect(result.checks.map((check) => check.name)).toEqual(expect.arrayContaining(["profile_directory_permissions", "profile_file_permissions", "service_manifest", "service_installed", "service_active", "shell_runtime", "execution_mode", "policy_revision", "tool:python", "tool:docker"]));
      expect(result.checks.filter((check) => check.name === "tool:python" || check.name === "tool:docker").map((check) => ({ name: check.name, status: check.status }))).toEqual([{ name: "tool:python", status: "warning" }, { name: "tool:docker", status: "warning" }]);
      expect(exitCodes).toEqual([]);
      const failingExitCodes: number[] = [];
      await runCli(["doctor", "--json"], { store: new ProfileStore({ baseDir: join(test.root, "missing-profile") }), stdout: () => undefined, servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, setExitCode: (code) => failingExitCodes.push(code) });
      expect(failingExitCodes).toEqual([1]);
    } finally { await test.cleanup(); }
  });
  it("requires administrator/root for system installation and uses injected Linux auto-start adapter", async () => {
    const test = await fixture();
    try {
      const contents = new Map<string, string>();
      const filesystem: ServiceManifestFilesystem = { read: async (path) => contents.get(path), write: async (path, content) => { contents.set(path, content); }, remove: async (path) => { contents.delete(path); } };
      const commands: string[] = [];
      const manager = createServiceManager({ platform: "linux", mode: "system", executor: { execute: async (file, args) => { commands.push([file, ...args].join(" ")); return { exitCode: 0 }; } } });
      const deniedErrors: string[] = [];
      await expect(runCli(["install"], { store: test.store, stderr: (line) => deniedErrors.push(line), servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, isAdministrator: () => false })).rejects.toThrow("administrator/root");
      const installOutput: string[] = [];
      await runCli(["install", "--json"], { store: test.store, stdout: (line) => installOutput.push(line), servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, serviceProvisioner: { platform: "linux", provision: async () => ({ identity: "runmesh", profileSecured: true }) }, isAdministrator: () => true });
      expect(commands).toEqual(["systemctl daemon-reload", "systemctl enable --now runmesh-runner.service", "systemctl is-active --quiet runmesh-runner.service"]);
      expect([...contents.values()][0]).toContain("ExecStart=/opt/runmesh/current/bin/coding-runner start");
    } finally { await test.cleanup(); }
  });
  it("renders hashed system service manifests and refuses unrelated overwrite/removal", async () => {
    const test = await fixture();
    try {
      const manifest = renderService({ platform: "linux", mode: "user", home: test.root });
      expect(manifest.content).toContain("ExecStart="); expect(isManagedService(manifest.content)).toBe(true);
      await installServiceManifest(manifest);
      await writeFile(manifest.path, "not ours");
      await expect(installServiceManifest(manifest)).rejects.toThrow("unmanaged");
      await expect(removeServiceManifest(manifest)).rejects.toThrow("unmanaged");
      expect(renderService({ platform: "darwin", home: test.root }).content).toContain("io.alone.runmesh.runner");
      expect(renderService({ platform: "win32", home: test.root }).content).toContain("Task");
    } finally { await test.cleanup(); }
  });
  it("classifies revoked and HTTP authentication failures separately from networks", () => {
    expect(classifyConnectionFailure({ statusCode: 401 })).toBe("authentication");
    expect(classifyConnectionFailure({ closeCode: 4001, reason: "credentials revoked" })).toBe("authentication");
    expect(classifyConnectionFailure({ closeCode: 1002, reason: "unsupported_protocol_version" })).toBe("authentication");
    expect(classifyConnectionFailure({ error: new Error("ECONNREFUSED") })).toBe("network");
  });
});
