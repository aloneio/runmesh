import { expect, it } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderManagedLauncher, renderWindowsMaintenanceUninstall } from "../src/updates/launchers.js";
import { trustedWindowsRoot } from "../src/windows-tools.js";

const execute = promisify(execFile);
async function fixture(purge = false) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "runmesh-launcher-")));
  const root = join(temporary, "managed install"); const version = join(root, "versions", "0.1.6");
  const manager = join(root, "manager"); const windows = process.platform === "win32";
  const runtimeName = windows ? "node.exe" : "node";
  const packageRoot = windows ? version : join(version, "lib", "node_modules", "@aloneio", "runmesh-runner", "dist");
  for (const directory of [join(version, "runtime"), packageRoot, join(version, "bin"), join(manager, "runtime")]) await mkdir(directory, { recursive: true });
  for (const directory of [version, manager]) { await copyFile(process.execPath, join(directory, "runtime", runtimeName)); await chmod(join(directory, "runtime", runtimeName), 0o755); }
  await writeFile(join(packageRoot, "runmesh.cjs"), 'console.log(JSON.stringify({source:"0.1.6",args:process.argv.slice(2)}));');
  await writeFile(join(manager, "runmesh.cjs"), `const fs=require('node:fs'); ${purge ? `fs.rmSync(${JSON.stringify(root)},{recursive:true,force:true});` : ""} console.log(JSON.stringify({source:'manager',args:process.argv.slice(2),runtime:process.execPath})); if(process.argv.includes('--fail'))process.exitCode=23;`);
  if (windows) await writeFile(join(manager, "uninstall.ps1"), renderWindowsMaintenanceUninstall());
  const launcher = windows ? join(version, "runmesh.cmd") : join(version, "bin", "runmesh");
  await writeFile(launcher, renderManagedLauncher(windows ? "win32" : process.platform === "darwin" ? "darwin" : "linux", root), { mode: 0o755 });
  const run = async (args: readonly string[]) => {
    const result = windows
      ? await execute(`${trustedWindowsRoot()}\\System32\\cmd.exe`, ["/d", "/s", "/c", `""${launcher}" ${args.map(value => `"${value}"`).join(" ")}"`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 30_000 })
      : await execute(launcher, [...args], { timeout: 30_000 });
    return JSON.parse(result.stdout.trim()) as { source: string; args: string[]; runtime: string };
  };
  return { root, temporary, manager, launcher, run, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

it("keeps old-version start and version queries while routing service management to the independent CLI", async () => {
  const test = await fixture();
  try {
    for (const command of ["start", "--version", "doctor"]) expect(await test.run([command])).toMatchObject({ source: "0.1.6", args: [command] });
    for (const command of ["install", "migrate", "stop", "restart", "uninstall"]) {
      expect(await test.run([command, "--profile", "profile with spaces!.json", "--json"])).toMatchObject({ source: "manager", args: [command, "--profile", "profile with spaces!.json", "--json"] });
    }
    await expect(test.run(["uninstall", "--fail"])).rejects.toMatchObject({ code: 23 });
    await rm(test.manager, { recursive: true });
    await expect(test.run(["uninstall", "--purge", "--yes"])).rejects.toThrow();
    expect(await test.run(["--version"])).toMatchObject({ source: "0.1.6" });
  } finally { await test.cleanup(); }
}, 60000);

it.runIf(process.platform === "win32")("runs Windows purge outside both installed runtimes and synchronously returns its result", async () => {
  const test = await fixture(true);
  try {
    await writeFile(join(test.temporary, "workspace.txt"), "keep project");
    const result = await test.run(["uninstall", "--purge", "--yes"]);
    expect(result).toMatchObject({ source: "manager", args: ["uninstall", "--purge", "--yes"] });
    expect(result.runtime.toLowerCase().startsWith(test.root.toLowerCase())).toBe(false);
    await expect(readFile(join(test.manager, "runmesh.cjs"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(result.runtime)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(test.temporary, "workspace.txt"), "utf8")).toBe("keep project");
  } finally { await test.cleanup(); }
}, 60000);
