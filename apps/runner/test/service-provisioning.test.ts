import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceProvisioner, renderService, serviceLayout, serviceProfilePath } from "../src/service.js";

describe("native service package ownership", () => {
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
