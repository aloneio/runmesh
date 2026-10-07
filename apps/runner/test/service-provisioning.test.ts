import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceManager, createServiceProvisioner, renderService, serviceLayout, serviceProfilePath } from "../src/service.js";
import { resolveTrustedWindowsTool, trustedWindowsEnvironment, trustedWindowsRoot } from "../src/windows-tools.js";

// Hosted Windows has taken 8.1s to reach the synthetic probe, before the
// unchanged service script's 5s stop observation. That cannot fit the old
// 12s total. This fixture-only budget includes setup and host teardown; the
// real host executor has no corresponding overall deadline.
const WINDOWS_TASK_PROBE_TIMEOUT_MS = 30_000;
const WINDOWS_TASK_PROBE_TEST_MARGIN_MS = 5_000;

function runSyntheticTaskProbe(script: string, state: "stopped" | "absent" | "running" | "queued" | "denied" | "unknown") {
  const task = state === "absent" ? "throw [System.IO.FileNotFoundException]::new()"
    : state === "denied" ? "throw [System.UnauthorizedAccessException]::new('synthetic access denied')"
      : state === "unknown" ? "throw [System.InvalidOperationException]::new('synthetic unknown state')" : "$script:taskFixture";
  // Replace COM construction inside a fresh PowerShell process. Every object
  // below is synthetic; no host service or task is inspected.
  const fixture = `$script:taskFixture = [pscustomobject]@{State=${state === "queued" ? 2 : state === "running" ? 4 : 3}; Definition=[pscustomobject]@{Principal=[pscustomobject]@{UserId='SYSTEM'}}};
$script:taskFixture | Add-Member ScriptMethod GetInstances { [pscustomobject]@{Count=${state === "running" ? 1 : 0}} };
$script:folderFixture = [pscustomobject]@{};
$script:folderFixture | Add-Member ScriptMethod GetTask { ${task} };
$script:serviceFixture = [pscustomobject]@{};
$script:serviceFixture | Add-Member ScriptMethod Connect {};
$script:serviceFixture | Add-Member ScriptMethod GetFolder { $script:folderFixture };
function New-Object { param([string]$ComObject) if ($ComObject -ne 'Schedule.Service') { throw 'unexpected synthetic object' }; $script:serviceFixture };
`;
  const systemRoot = trustedWindowsRoot();
  // Windows PowerShell reconstructs module search paths even with the trusted
  // environment. Load the inbox cmdlets used by the fixture and probe directly
  // so discovery does not scan user or CI-installed modules.
  const source = "$ErrorActionPreference='Stop'; $script:taskProbeClock=[System.Diagnostics.Stopwatch]::StartNew();\n"
    + "function Write-RunmeshTaskProbeStage([string]$stage) { [Console]::Error.WriteLine(('RUNMESH_TEST_TASK_PROBE={0};elapsed_ms={1}' -f $stage,$script:taskProbeClock.ElapsedMilliseconds)) }; Write-RunmeshTaskProbeStage 'started';\n"
    + "try {\n$PSModuleAutoLoadingPreference='None'; Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop; Write-RunmeshTaskProbeStage 'module_ready';\n"
    + fixture + "Write-RunmeshTaskProbeStage 'ready';\ntry {\n" + script
    // Preserve the generated probe and its exit code, while keeping errors out
    // of EncodedCommand's host-specific CLIXML formatter. Both exit and throw
    // execute finally, separating script completion from process teardown.
    + "\n} finally { Write-RunmeshTaskProbeStage 'completed' }\n"
    + "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 } finally { Write-RunmeshTaskProbeStage 'exit' }";
  // Match the host executor's trusted environment and working directory, keep
  // this synthetic script literal, and close stdin.
  const started = performance.now();
  const result = spawnSync(resolveTrustedWindowsTool("powershell.exe", systemRoot), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: WINDOWS_TASK_PROBE_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    cwd: join(systemRoot, "System32"), env: trustedWindowsEnvironment(systemRoot),
  });
  const stdout = result.stdout ?? "", stderr = result.stderr ?? "";
  const progressPattern = /^RUNMESH_TEST_TASK_PROBE=(started|module_ready|ready|completed|exit);elapsed_ms=(\d+)\r?\n?/gmu;
  const progress = [...stderr.matchAll(progressPattern)].map(match => ({ phase: match[1]!, elapsed_ms: Number(match[2]) }));
  const last = progress.at(-1)?.phase;
  const stage = last === "exit" ? "host_exit" : last === "completed" ? "error_output" : last === "ready" ? "probe"
    : last === "module_ready" ? "fixture_setup" : last === "started" ? "module_load" : "startup";
  const scriptCompleted = progress.some(item => item.phase === "completed");
  const code = result.error?.code;
  const diagnostic = JSON.stringify({ native_task_fixture: stage, status: result.status, signal: result.signal,
    error_code: code === undefined ? null : ["ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "ENOBUFS"].includes(code) ? code : "other",
    elapsed_ms: Math.round(performance.now() - started), progress,
    stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr) });
  return { ...result, stage, scriptCompleted, diagnostic, stdout, stderr: stderr.replace(progressPattern, "") };
}

function expectSyntheticProbeCompleted(result: ReturnType<typeof runSyntheticTaskProbe>): void {
  // These assertions must stay outside the product's injected executor: status
  // correctly catches probe failures, including an AssertionError thrown there.
  expect(result.error === undefined, result.diagnostic).toBe(true);
  expect(result.signal, result.diagnostic).toBeNull();
  expect(result.status, result.diagnostic).not.toBeNull();
  expect(result.scriptCompleted, result.diagnostic).toBe(true);
  expect(result.stage, result.diagnostic).toBe("host_exit");
}

describe("native service package ownership", () => {
  it.skipIf(process.platform !== "win32")("preserves a synthetic probe failure without depending on host error formatting", () => {
    const result = runSyntheticTaskProbe("throw 'synthetic probe failure'", "stopped");
    expect(result.status, result.diagnostic).toBe(1);
    expect(result.stderr.trim()).toBe("synthetic probe failure");
    expectSyntheticProbeCompleted(result);
  }, WINDOWS_TASK_PROBE_TIMEOUT_MS + WINDOWS_TASK_PROBE_TEST_MARGIN_MS);

  it("preserves a macOS registration when its native state probe is denied", async () => {
    const manifest = renderService({ platform: "darwin", mode: "system" });
    const calls: string[][] = [];
    const manager = createServiceManager({ platform: "darwin", mode: "system", filesystem: { read: async () => manifest.content },
      executor: { execute: async (file, args) => { calls.push([file, ...args]); return { exitCode: 1, stderr: "Operation not permitted" }; } } });
    await expect(manager.stop(manifest)).rejects.toThrow("state could not be verified");
    await expect(manager.restart(manifest)).rejects.toThrow("state could not be verified");
    await expect(manager.uninstall(manifest)).rejects.toThrow("state could not be verified");
    expect(calls.every(call => call[1] === "print")).toBe(true);
  });

  it.each([undefined, "<plist>foreign</plist>"])("keeps an unloaded macOS service stopped when its managed manifest is absent or changed", async content => {
    const calls: string[][] = [];
    const manager = createServiceManager({ platform: "darwin", mode: "system", filesystem: { read: async () => content },
      executor: { execute: async (file, args) => { calls.push([file, ...args]); return { exitCode: 113, stderr: "Could not find service" }; } } });
    const manifest = renderService({ platform: "darwin", mode: "system" });
    await expect(manager.status?.(manifest)).resolves.toMatchObject({ installed: false, registered: false, active: false });
    await expect(manager.restart(manifest)).rejects.toThrow("manifest is missing");
    expect(calls.every(call => call[1] === "print")).toBe(true);
  });

  it.skipIf(process.platform !== "win32").each(["stopped", "absent", "running", "queued", "denied", "unknown"] as const)("evaluates the Windows stop probe against a synthetic %s task", async state => {
    let script = "";
    const manager = createServiceManager({ platform: "win32", mode: "system", executor: {
      execute: async (file, args) => { if (file === "powershell.exe") { script = args.at(-1)!; return { exitCode: 0, stdout: "stopped" }; } return { exitCode: 0 }; },
    } });
    await manager.stop(renderService({ platform: "win32", mode: "system" }));
    const result = runSyntheticTaskProbe(script, state);
    expectSyntheticProbeCompleted(result);
    if (state === "running" || state === "queued") {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Runner task is still active");
    } else if (state === "denied" || state === "unknown") {
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("absent");
      expect(result.stderr).toContain(state === "denied" ? "synthetic access denied" : "synthetic unknown state");
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(state);
    }
  }, WINDOWS_TASK_PROBE_TIMEOUT_MS + WINDOWS_TASK_PROBE_TEST_MARGIN_MS);

  it.skipIf(process.platform !== "win32").each(["absent", "denied", "unknown"] as const)("classifies a synthetic Windows %s exception through public status", async state => {
    const calls: string[][] = [];
    const observations: ReturnType<typeof runSyntheticTaskProbe>[] = [];
    const manager = createServiceManager({ platform: "win32", mode: "system", executor: {
      execute: async (file, args) => {
        calls.push([file, ...args]);
        if (file !== "powershell.exe") return { exitCode: 1, stderr: "native query unavailable" };
        const result = runSyntheticTaskProbe(args.at(-1)!, state);
        observations.push(result);
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
    } });
    const status = await manager.status?.(renderService({ platform: "win32", mode: "system" }));
    expect(observations).toHaveLength(1);
    observations.forEach(expectSyntheticProbeCompleted);
    if (state === "absent") expect(status).toMatchObject({ installed: false, active: false, registered: false, reliable: true });
    else {
      expect(status).toMatchObject({ reliable: false });
      expect(status?.registered).toBeUndefined();
      await expect(manager.uninstall(renderService({ platform: "win32", mode: "system" }))).rejects.toThrow("confirmed stopped");
      expect(observations).toHaveLength(2);
      observations.forEach(expectSyntheticProbeCompleted);
      expect(calls.some(call => call.includes("/Delete"))).toBe(false);
    }
  }, 2 * WINDOWS_TASK_PROBE_TIMEOUT_MS + WINDOWS_TASK_PROBE_TEST_MARGIN_MS);

  it("keeps a timed-out Windows task query distinct from confirmed absence", async () => {
    const manager = createServiceManager({ platform: "win32", mode: "system", executor: {
      execute: async file => {
        if (file === "powershell.exe") throw Object.assign(new Error("native probe timed out"), { code: "ETIMEDOUT" });
        return { exitCode: 1, stderr: "native query unavailable" };
      },
    } });
    const status = await manager.status?.(renderService({ platform: "win32", mode: "system" }));
    expect(status).toMatchObject({ installed: false, active: false, reliable: false });
    expect(status?.registered).toBeUndefined();
  });

  it.each([0, 1])("keeps a running Windows task registered when stop returns %s but completion is unverified", async exitCode => {
    const calls: string[][] = [];
    const manager = createServiceManager({ platform: "win32", mode: "system", executor: {
      execute: async (file, args) => { calls.push([file, ...args]);
        return file === "schtasks" ? { exitCode } : { exitCode: 1, stderr: "Runner task is still active" }; },
    } });
    await expect(manager.uninstall(renderService({ platform: "win32", mode: "system" }))).rejects.toThrow("confirmed stopped");
    expect(calls.some(call => call.includes("/Delete"))).toBe(false);
  });

  it.each(["stopped", "absent"])("allows Windows task removal after an End error when native state is %s", async initial => {
    let state = initial;
    const calls: string[][] = [];
    const manager = createServiceManager({ platform: "win32", mode: "system", executor: {
      execute: async (file, args) => { calls.push([file, ...args]);
        if (file === "powershell.exe") return { exitCode: 0, stdout: state };
        if (args[0] === "/End") return { exitCode: 1 };
        if (args[0] === "/Delete") state = "absent";
        return { exitCode: 0 }; },
    } });
    const manifest = renderService({ platform: "win32", mode: "system" });
    await manager.uninstall(manifest);
    await manager.uninstall(manifest);
    expect(calls.filter(call => call.includes("/Delete"))).toHaveLength(initial === "stopped" ? 1 : 0);
  });

  it("fails Linux installation when the process exits just after systemd accepts startup", async () => {
    vi.useFakeTimers();
    try {
      let active = false;
      const manager = createServiceManager({ platform: "linux", mode: "system", executor: {
        execute: async (_file, args) => {
          if (args.includes("enable")) { active = true; setTimeout(() => { active = false; }, 1); }
          return { exitCode: args.includes("is-active") && !active ? 3 : 0 };
        },
      } });
      const outcome = manager.install(renderService({ platform: "linux", mode: "system" })).then(() => "reported success", () => "startup rejected");
      await vi.runAllTimersAsync();
      expect(await outcome).toBe("startup rejected");
    } finally { vi.useRealTimers(); }
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("makes private bootstrap packages readable and traversable without following links", async () => {
    const platform = process.platform as "linux" | "darwin";
    const commands: string[][] = [];
    const provisioner = createServiceProvisioner({ platform, executor: {
      execute: async (file, args) => {
        if (file === "find" && args.includes("/opt/runmesh") && args.includes("chmod")) commands.push([...args]);
        return { exitCode: 0, stdout: "PrimaryGroupID: 501" };
      },
    } });
    await provisioner.provision(renderService({ platform, mode: "system" }), serviceProfilePath(serviceLayout({ platform, mode: "system" })));
    const parent = await mkdtemp(join(tmpdir(), "runmesh-private-package-"));
    const root = join(parent, "install"), directory = join(root, "version"), outside = join(parent, "outside");
    try {
      await mkdir(root, { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
      const executable = join(directory, "runner"), source = join(directory, "source.js");
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await writeFile(source, "// package code\n", { mode: 0o600 });
      await writeFile(outside, "private fixture", { mode: 0o600 });
      await symlink(outside, join(directory, "outside-link"));
      expect(commands.length).toBeGreaterThan(0);
      for (const args of commands) {
        const result = spawnSync("find", args.map(arg => arg === "/opt/runmesh" ? root : arg), { encoding: "utf8", timeout: 10_000 });
        expect(result.status, result.stderr).toBe(0);
      }
      for (const path of [root, directory, executable]) expect((await stat(path)).mode & 0o777).toBe(0o555);
      expect((await stat(source)).mode & 0o777).toBe(0o444);
      expect((await stat(outside)).mode & 0o777).toBe(0o600);
    } finally {
      await chmod(root, 0o700).catch(() => undefined); await chmod(directory, 0o700).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin").each(["dedicated_user", "privileged_host"] as const)("keeps existing %s runtime state private across repeated provisioning", async executionMode => {
    const platform = process.platform as "linux" | "darwin";
    const layout = serviceLayout({ platform, mode: "system" });
    const commands: { file: string; args: readonly string[] }[] = [];
    const provisioner = createServiceProvisioner({ platform, executor: {
      execute: async (file, args) => {
        if (args.includes(layout.stateRoot) && (file === "chmod" || (file === "find" && args.includes("chmod")))) commands.push({ file, args });
        return { exitCode: 0, stdout: "PrimaryGroupID: 501" };
      },
    } });
    const parent = await mkdtemp(join(tmpdir(), "runmesh-private-state-"));
    const root = join(parent, "state"), policy = join(root, "policy"), jobs = join(root, "jobs");
    const activePolicy = join(policy, "active-policy.json"), job = join(jobs, "job.json"), outside = join(parent, "workspace.txt");
    try {
      for (const directory of [root, policy, jobs]) await mkdir(directory, { mode: 0o700 });
      for (const path of [activePolicy, job, outside]) await writeFile(path, "private fixture", { mode: 0o600 });
      await symlink(outside, join(root, "workspace-link"));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        commands.length = 0;
        await provisioner.provision(renderService({ platform, mode: "system", executionMode }), serviceProfilePath(layout));
        expect(commands.length).toBeGreaterThan(0);
        for (const { file, args } of commands) {
          // Execute only state permission actions against this disposable tree.
          const mapped = file === "chmod" ? [args[0]!, root] : args.map(arg => arg === layout.stateRoot ? root : arg);
          const result = spawnSync(file, mapped, { encoding: "utf8", timeout: 10_000 });
          expect(result.status, result.stderr).toBe(0);
        }
        for (const directory of [root, policy, jobs]) expect((await stat(directory)).mode & 0o777).toBe(0o700);
        for (const path of [activePolicy, job, outside]) {
          expect((await stat(path)).mode & 0o777).toBe(0o600);
          expect(await readFile(path, "utf8")).toBe("private fixture");
        }
      }
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it.each(["dedicated_user", "privileged_host"] as const)("provisions macOS %s with native account and traversal syntax", async (executionMode) => {
    const commands: { file: string; args: readonly string[] }[] = [];
    const provisioner = createServiceProvisioner({
      platform: "darwin",
      executor: {
        execute: async (file, args) => {
          commands.push({ file, args });
          // A standard macOS host has the root user and wheel group, but no
          // root group. Model the native failure instead of invoking chown.
          if ((file === "chown" || (file === "find" && args.includes("chown"))) && args.includes("root:root")) {
            return { exitCode: 1, stderr: "chown: root: illegal group name" };
          }
          // BSD find accepts -x only as a global option before any path.
          if (file === "find" && args.indexOf("-x") > args.findIndex(arg => arg.startsWith("/"))) {
            return { exitCode: 1, stderr: "find: -x: unknown primary or operator" };
          }
          return { exitCode: 0, stdout: "PrimaryGroupID: 501" };
        },
      },
    });
    const layout = serviceLayout({ platform: "darwin", mode: "system" });
    await expect(provisioner.provision(renderService({ platform: "darwin", mode: "system", executionMode }), serviceProfilePath(layout)))
      .resolves.toMatchObject({ identity: executionMode === "privileged_host" ? "root" : "runmesh", profileSecured: true });
    const packageOwnership = commands.filter(({ file, args }) => file === "find" && args.includes(layout.installRoot) && args.includes("chown"));
    expect(packageOwnership).toHaveLength(2);
    expect(packageOwnership.every(({ args }) => args.includes("root:wheel"))).toBe(true);
  });

  it.skipIf(process.platform !== "darwin").each(["dedicated_user", "privileged_host"] as const)("executes generated macOS %s find syntax against a temporary tree", async executionMode => {
    const captured: string[][] = [];
    const provisioner = createServiceProvisioner({ platform: "darwin", executor: {
      execute: async (file, args) => { if (file === "find") captured.push([...args]); return { exitCode: 0, stdout: "PrimaryGroupID: 501" }; },
    } });
    const layout = serviceLayout({ platform: "darwin", mode: "system" });
    await provisioner.provision(renderService({ platform: "darwin", mode: "system", executionMode }), serviceProfilePath(layout));
    const root = await mkdtemp(join(tmpdir(), "runmesh-native-find-"));
    try {
      const directory = join(root, "nested directory"), file = join(directory, "fixture.txt");
      await mkdir(directory); await writeFile(file, "fixture");
      expect(captured.length).toBeGreaterThan(0);
      for (const args of captured) {
        const executeIndex = args.indexOf("-exec");
        expect(executeIndex).toBeGreaterThan(0);
        expect(["chown", "chmod"]).toContain(args[executeIndex + 1]);
        const systemPaths = [layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot];
        const traversal = args.slice(0, executeIndex);
        expect(traversal.filter(arg => systemPaths.includes(arg))).toHaveLength(1);
        // Retain the generated options, but replace the sole root and every
        // mutating action before invoking the actual macOS /usr/bin/find.
        const inspection = [...traversal.map(arg => systemPaths.includes(arg) ? root : arg), "-print"];
        const result = spawnSync("/usr/bin/find", inspection, { encoding: "utf8", timeout: 10_000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const paths = result.stdout.trim().split("\n");
        expect(paths).toContain(args[args.indexOf("-type") + 1] === "d" ? directory : file);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "win32")("creates literal Windows service directories with native PowerShell before ACL provisioning", async () => {
    let script = "";
    const provisioner = createServiceProvisioner({ platform: "win32", executor: {
      execute: async (_file, args) => { script = args.at(-1) ?? ""; return { exitCode: 0 }; },
    } });
    const layout = serviceLayout({ platform: "win32", mode: "system" });
    await provisioner.provision(renderService({ platform: "win32", mode: "system" }), serviceProfilePath(layout));
    const root = await mkdtemp(join(tmpdir(), "runmesh-service-paths-"));
    try {
      // Run only directory creation, never the ACL or real installation
      // commands. Every fixed system path is replaced by a disposable path.
      expect(script.indexOf("& icacls")).toBeGreaterThan(0);
      let creation = script.slice(0, script.indexOf("& icacls"));
      const expected: string[] = [];
      for (const [index, path] of [layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot].entries()) {
        const temporary = join(root, `literal[${index}]'directory`);
        expected.push(temporary);
        creation = creation.replaceAll(`'${path.replaceAll("'", "''")}'`, `'${temporary.replaceAll("'", "''")}'`);
      }
      for (const path of [layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]) expect(creation).not.toContain(path);
      // EncodedCommand preserves literal quotes through Windows argv parsing.
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`${creation}${creation}`, "utf16le").toString("base64")], {
        encoding: "utf8", windowsHide: true, timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      for (const path of expected) expect((await stat(path)).isDirectory()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  });
});
