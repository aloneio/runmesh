import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, runEnrollCli, parseProductArgs } from "../src/cli.js";
import { RunnerConnection, classifyConnectionFailure } from "../src/connection.js";
import { RUNNER_VERSION } from "../src/version.js";
import { enrollRunner } from "../src/enrollment.js";
import { ProfileStore, defaultWorkspaceId, validateProfile } from "../src/profile.js";
import { createServiceManager, createServiceProvisioner, installServiceManifest, isManagedService, removeServiceManifest, renderService, serviceLayout, serviceProfilePath, type ServiceManifestFilesystem } from "../src/service.js";

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
      // Windows ACLs are not represented by the POSIX mode bits exposed by
      // Node's stat(); the service provisioner covers the native ACL path.
      if (process.platform !== "win32") expect((await stat(test.store.filePath)).mode & 0o777).toBe(0o600);
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
  it("accepts enrollment codes from stdin without putting them in argv", async () => {
    const test = await fixture();
    try {
      const lines: string[] = [];
      const code = "b".repeat(43);
      await runEnrollCli(["--server", "https://example.test/runner/enroll", "--code-stdin", "--json"], {
        store: test.store,
        readStdin: async () => `${code}\n`,
        stdout: (line) => lines.push(line),
        fetch: async (_url, init) => {
          expect(init?.body).toContain(code);
          return new Response(JSON.stringify({ runner_id: "runner-stdin", server_url: "https://example.test/runner/connect", token: "stdin-token-0123456789" }), { status: 200 });
        },
      });
      expect(lines.join("\n")).toContain("runner-stdin");
      expect(await test.store.load()).toMatchObject({ runner_id: "runner-stdin" });
      expect(parseProductArgs(["enroll", "--server", "https://example.test/runner/enroll", "--code-stdin"]).values).toMatchObject({ codeStdin: true });
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", code, "--code-stdin"], { store: test.store, readStdin: async () => code })).rejects.toThrow("cannot be used together");
    } finally { await test.cleanup(); }
  });
  it("removes the profile when post-enrollment activation fails after irreversible redemption", async () => {
    const test = await fixture();
    try {
      const original = profile(join(test.root, "workspace"));
      const errors: string[] = [];
      await test.store.save(original);
      await expect(runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code-stdin", "--re-enroll"], {
        store: test.store,
        readStdin: async () => `${"c".repeat(43)}\n`,
        afterEnroll: async () => { throw new Error("post-enrollment activation failed"); },
        stderr: (line) => errors.push(line),
        fetch: async () => new Response(JSON.stringify({ runner_id: "rollback-runner", server_url: "https://example.test/runner/connect", token: "rollback-token-0123456789" }), { status: 200 }),
      })).rejects.toThrow("post-enrollment activation failed");
      await expect(test.store.load()).resolves.toBeUndefined();
      expect(errors.join("\n")).toContain("credentials were consumed");
      expect(errors.join("\n")).toContain("generate a new enrollment code");
    } finally { await test.cleanup(); }
  });

  it("does not remove a profile replaced by a concurrent enrollment during cleanup", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      await expect(runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code", "c".repeat(43), "--re-enroll"], {
        store: test.store,
        afterEnroll: async () => {
          await test.store.save({ ...profile(join(test.root, "workspace")), runner_id: "concurrent-runner", token: "concurrent-token-0123456789" });
          throw new Error("post-enrollment activation failed");
        },
        fetch: async () => new Response(JSON.stringify({ runner_id: "first-runner", server_url: "https://example.test/runner/connect", token: "first-token-0123456789" }), { status: 200 }),
      })).rejects.toThrow("post-enrollment activation failed");
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "concurrent-runner", token: "concurrent-token-0123456789" });
    } finally { await test.cleanup(); }
  });

  it("clears a stale profile and reports an unknown outcome when enrollment transport fails", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      const errors: string[] = [];
      await expect(runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code", "d".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => { throw new Error("socket reset"); },
      })).rejects.toThrow("outcome is unknown");
      await expect(test.store.load()).resolves.toBeUndefined();
      expect(errors.join("\n")).toContain("local profile was removed");
      expect(errors.join("\n")).toContain("generate a new enrollment code");
    } finally { await test.cleanup(); }
  });

  it("preserves a profile written by a concurrent enrollment after an unknown response", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      await expect(runCli(["enroll", "--server", "https://example.test/runner/enroll", "--code", "d".repeat(43), "--re-enroll"], {
        store: test.store,
        fetch: async () => {
          await test.store.save({ ...profile(join(test.root, "workspace")), runner_id: "concurrent-runner", token: "concurrent-token-0123456789" });
          throw new Error("socket reset");
        },
      })).rejects.toThrow("outcome is unknown");
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: "concurrent-runner", token: "concurrent-token-0123456789" });
    } finally { await test.cleanup(); }
  });

  it("keeps the previous profile for a definitive enrollment rejection", async () => {
    const test = await fixture();
    try {
      const original = profile(join(test.root, "workspace"));
      await test.store.save(original);
      const errors: string[] = [];
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "e".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => new Response("invalid enrollment", { status: 401 }),
      })).rejects.toThrow("enrollment failed (401)");
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: original.runner_id, token: original.token });
      expect(errors).toEqual(["enrollment failed (401)"]);
    } finally { await test.cleanup(); }
  });

  it("keeps the profile when another enrollment already owns the Runner fence", async () => {
    const test = await fixture();
    try {
      const original = profile(join(test.root, "workspace"));
      await test.store.save(original);
      const errors: string[] = [];
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "g".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => new Response("Runner credential mutation is already in progress", { status: 409 }),
      })).rejects.toThrow("already in progress");
      await expect(test.store.load()).resolves.toMatchObject({ runner_id: original.runner_id, token: original.token });
      expect(errors).toEqual(["enrollment is already in progress for this Runner; wait for it to finish and retry"]);
    } finally { await test.cleanup(); }
  });

  it("treats redirects as an unknown enrollment outcome", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      const errors: string[] = [];
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "h".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => new Response(null, { status: 302, headers: { location: "https://example.test/runner/enroll" } }),
      })).rejects.toThrow("outcome is unknown");
      await expect(test.store.load()).resolves.toBeUndefined();
      expect(errors.join("\n")).toContain("local profile was removed");
    } finally { await test.cleanup(); }
  });

  it("treats an invalid response status as an unknown enrollment outcome", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      const errors: string[] = [];
      const invalidStatus = { ok: false, status: 0 } as Response;
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "i".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => invalidStatus,
      })).rejects.toThrow("outcome is unknown");
      await expect(test.store.load()).resolves.toBeUndefined();
      expect(errors.join("\n")).toContain("local profile was removed");
    } finally { await test.cleanup(); }
  });

  it("clears the previous profile when a success response cannot be trusted", async () => {
    const test = await fixture();
    try {
      await test.store.save(profile(join(test.root, "workspace")));
      const errors: string[] = [];
      await expect(runEnrollCli(["--server", "https://example.test/runner/enroll", "--code", "f".repeat(43), "--re-enroll"], {
        store: test.store,
        stderr: (line) => errors.push(line),
        fetch: async () => new Response("not-json", { status: 200 }),
      })).rejects.toThrow("outcome is unknown");
      await expect(test.store.load()).resolves.toBeUndefined();
      expect(errors.join("\n")).toContain("local profile was removed");
    } finally { await test.cleanup(); }
  });

  it("rejects cleartext enrollment except explicit loopback development", async () => {
    const test = await fixture();
    try {
      await expect(enrollRunner({ server: "http://example.test/runner/enroll", code: "a".repeat(43), cwd: join(test.root, "workspace"), store: test.store, fetch: async () => new Response() })).rejects.toThrow("https:// is required");
      await expect(enrollRunner({ server: "https://user:password@example.test/runner/enroll", code: "a".repeat(43), store: test.store, fetch: async () => new Response() })).rejects.toThrow("credentials");
      const result = await enrollRunner({ server: "http://127.0.0.1/runner/enroll", code: "a".repeat(43), insecureLocal: true, cwd: join(test.root, "workspace"), store: test.store, fetch: async () => new Response(JSON.stringify({ runner_id: "runner-1", server_url: "http://127.0.0.1/runner/connect", token: "fedcba9876543210" }), { status: 200 }) });
      expect(result.profile).toMatchObject({ runner_id: "runner-1", server_url: "ws://127.0.0.1/runner/connect", insecure_local: true });
      await expect(test.store.load()).resolves.toMatchObject({ insecure_local: true });
      expect(validateProfile({ ...result.profile, server_url: "wss://user:password@example.test/runner/connect" })).toBeUndefined();
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
  it("escapes systemd specifiers and control characters in generated values", () => {
    const manifest = renderService({
      platform: "linux", mode: "user", executablePath: "/opt/run%mesh/coding runner",
      profilePath: "/tmp/profile%name\nnext", stateDir: "/tmp/state\tname",
    });
    expect(manifest.content).toContain("ExecStart=/opt/run%%mesh/coding\\x20runner start");
    expect(manifest.content).toContain('RUNMESH_RUNNER_PROFILE=/tmp/profile%%name\\x0anext');
    expect(manifest.content).toContain("--state-dir /tmp/state\\x09name");
    expect(manifest.content).not.toContain("profile%name");
  });
  it("includes fail-closed checks for Windows ACL commands", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const provisioner = createServiceProvisioner({
      platform: "win32",
      executor: { execute: async (file, args) => { calls.push({ file, args }); return { exitCode: 0 }; } },
    });
    const layout = serviceLayout({ platform: "win32", mode: "system" });
    await provisioner.provision(renderService({ platform: "win32", mode: "system" }), serviceProfilePath(layout));
    const script = calls.at(-1)?.args.at(-1) ?? "";
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain("if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }");
  });
  it("does not treat a Windows Task Scheduler Ready state as running", async () => {
    const managerFor = (state: string) => createServiceManager({
      platform: "win32", mode: "system",
      executor: { execute: async (_file, args) => args.includes("/FO") ? { exitCode: 0, stdout: `Status: ${state}\nRun As User: NT AUTHORITY\\LOCAL SERVICE` } : { exitCode: 0 } },
    });
    const manifest = renderService({ platform: "win32", mode: "system" });
    await expect(managerFor("Ready").status?.(manifest)).resolves.toMatchObject({ installed: true, active: false });
    await expect(managerFor("Running").status?.(manifest)).resolves.toMatchObject({ installed: true, active: true, identity: "NT AUTHORITY\\LOCAL SERVICE" });
  });
  it("quotes Windows task arguments with trailing backslashes safely", () => {
    const executablePath = String.raw`C:\Program Files\Runmesh\current\coding-runner.cmd`;
    const profilePath = String.raw`C:\Program Files\Runmesh\config\profile` + "\\";
    const stateDir = String.raw`C:\Program Files\Runmesh\state` + "\\";
    const manifest = renderService({ platform: "win32", mode: "system", executablePath, profilePath, stateDir });
    const argumentsText = (/<Arguments>([^<]*)<\/Arguments>/u.exec(manifest.content)?.[1] ?? "").replaceAll("&quot;", '"');
    // A trailing separator inside a quoted Windows argument must be doubled
    // before the closing quote; otherwise the parser treats that quote as
    // escaped and hands the service an incorrect path.
    expect(argumentsText).toContain(`--profile "${profilePath}${"\\"}"`);
    expect(argumentsText).toContain(`--state-dir "${stateDir}${"\\"}"`);
    expect(argumentsText).not.toContain(`--profile "${profilePath}"`);
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
      const doctorPlatform = process.platform === "win32" ? "win32" : "linux";
      const content = renderService({ platform: doctorPlatform, mode: "system", profilePath: test.store.filePath, executionMode: "dedicated_user" }).content;
      const filesystem: ServiceManifestFilesystem = { read: async () => content, write: async () => undefined, remove: async () => undefined };
      const manager = {
        platform: doctorPlatform, mode: "system" as const,
        install: async () => undefined, stop: async () => undefined, restart: async () => undefined, uninstall: async () => undefined,
        status: async () => ({ installed: true, active: true, identity: "runmesh" }),
      };
      const lines: string[] = []; const exitCodes: number[] = [];
      await runCli(["doctor", "--json"], {
        store: test.store, stdout: (line) => lines.push(line), servicePlatform: doctorPlatform, serviceFilesystem: filesystem, serviceManager: manager,
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
      // Keep the exit-code seam check independent of host process discovery.
      // Without these injected probes the second doctor invocation would
      // start real PowerShell/tool probes on Windows and can exceed Vitest's
      // default five-second test timeout.
      await runCli(["doctor", "--json"], {
        store: new ProfileStore({ baseDir: join(test.root, "missing-profile") }), stdout: () => undefined,
        servicePlatform: doctorPlatform, serviceFilesystem: filesystem, serviceManager: manager,
        discoverShellRuntime: async () => undefined,
        environment: new (await import("../src/runtime.js")).EnvironmentInfoService({ probe: async () => undefined }),
        setExitCode: (code) => failingExitCodes.push(code),
      });
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
      await test.store.save(profile(join(test.root, "workspace")));
      const installOutput: string[] = [];
      await runCli(["install", "--json"], { store: test.store, stdout: (line) => installOutput.push(line), servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, serviceProvisioner: { platform: "linux", provision: async () => ({ identity: "runmesh", profileSecured: true }) }, isAdministrator: () => true });
      expect(commands).toEqual(["systemctl daemon-reload", "systemctl enable --now runmesh-runner.service", "systemctl is-active --quiet runmesh-runner.service"]);
      expect([...contents.values()][0]).toContain("ExecStart=/opt/runmesh/current/bin/coding-runner start");
      } finally { await test.cleanup(); }
  });
  it("refuses to activate a service when its profile cannot be secured", async () => {
    const test = await fixture();
    try {
      const contents = new Map<string, string>();
      const filesystem: ServiceManifestFilesystem = { read: async (path) => contents.get(path), write: async (path, content) => { contents.set(path, content); }, remove: async (path) => { contents.delete(path); } };
      const manager = createServiceManager({ platform: "linux", mode: "system", executor: { execute: async () => ({ exitCode: 0 }) } });
      const provisioner = { platform: "linux" as const, provision: async () => ({ identity: "runmesh", profileSecured: false, detail: "profile is not present yet" }) };
      await test.store.save(profile(join(test.root, "workspace")));
      await expect(runCli(["install"], { store: test.store, servicePlatform: "linux", serviceFilesystem: filesystem, serviceManager: manager, serviceProvisioner: provisioner, isAdministrator: () => true })).rejects.toThrow("profile is not present yet");
      expect(contents.size).toBe(0);
    } finally { await test.cleanup(); }
  });
  it("renders hashed system service manifests and refuses unrelated overwrite/removal", async () => {
    const test = await fixture();
    try {
      // Use target-platform-shaped fixture roots. A Windows host path is not a
      // valid absolute POSIX path when rendering a Linux/macOS manifest.
      const fixtureHome = "/tmp/runmesh-test-home";
      const manifest = renderService({ platform: "linux", mode: "user", home: fixtureHome });
      expect(manifest.content).toContain("ExecStart="); expect(isManagedService(manifest.content)).toBe(true);
      const contents = new Map<string, string>();
      const filesystem: ServiceManifestFilesystem = { read: async (path) => contents.get(path), write: async (path, content) => { contents.set(path, content); }, remove: async (path) => { contents.delete(path); } };
      await installServiceManifest(manifest, filesystem);
      await filesystem.write(manifest.path, "not ours");
      await expect(installServiceManifest(manifest, filesystem)).rejects.toThrow("unmanaged");
      await expect(removeServiceManifest(manifest, filesystem)).rejects.toThrow("unmanaged");
      expect(renderService({ platform: "darwin", home: fixtureHome }).content).toContain("io.alone.runmesh.runner");
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
