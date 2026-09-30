import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceManager, createServiceProvisioner, renderService, serviceLayout, serviceProfilePath } from "../src/service.js";

describe("native service package ownership", () => {
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
