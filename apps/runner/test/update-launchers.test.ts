import { expect, it } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { renderManagedLauncher, renderWindowsMaintenanceUninstall } from "../src/updates/launchers.js";
import { trustedWindowsRoot } from "../src/windows-tools.js";

const execute = promisify(execFile);
async function waitForLockExit(completion: Promise<number | null>): Promise<number | null | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([completion, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 5_000); })]);
  } finally { clearTimeout(timer); }
}
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

for (const release of [true, false]) for (const exitCode of [0, 23])
it.runIf(process.platform === "win32")(`cleans a ${release ? "released" : "persistent"} Windows runtime lock without losing uninstall exit ${exitCode}`, async () => {
  const test = await fixture(), ready = join(test.temporary, "lock-ready.json"), held = join(test.temporary, "lock-held"), unlock = join(test.temporary, "unlock"), attempted = join(test.temporary, "cleanup-attempted");
  await writeFile(join(test.manager, "runmesh.cjs"), `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({runtime:process.execPath}));const wait=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(held)}))return;clearInterval(wait);console.log(JSON.stringify({source:'manager',args:process.argv.slice(2),runtime:process.execPath}));process.exitCode=${exitCode};},10);`);
  // Observe a real sharing violation before releasing the independent process.
  // This instruments the filesystem call, not the cleanup's decision or retry.
  const deletion = "[IO.Directory]::Delete($temporary,$true)";
  const probe = attempted.replaceAll("'", "''");
  await writeFile(join(test.manager, "uninstall.ps1"), renderWindowsMaintenanceUninstall().replace(deletion,
    `try { ${deletion} } catch { [IO.File]::WriteAllText('${probe}','attempted'); throw }`));
  const running = test.run(["uninstall"]).then(result => ({ result, error: undefined }), error => ({ result: undefined, error: error as Error & { code: number; stderr: string } }));
  let runtime: string | undefined;
  let lock: ReturnType<typeof spawn> | undefined;
  let lockCompletion: Promise<number | null> | undefined;
  const waitFor = async (path: string) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const value = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (value !== undefined) return value;
      if (Date.now() >= deadline) throw new Error("launcher fixture handshake timed out");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    runtime = (JSON.parse(await waitFor(ready)) as { runtime: string }).runtime;
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    // The holder belongs to the test, outside the launcher's process tree.
    // FileShare.Read keeps a real file handle open without granting deletion.
    lock = spawn(`${trustedWindowsRoot()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; $lock=[IO.File]::Open(${quote(runtime)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { [IO.File]::WriteAllText(${quote(held)},'held'); while(-not [IO.File]::Exists(${quote(unlock)})) { [Threading.Thread]::Sleep(10) } } finally { $lock.Dispose() }`], { windowsHide: true, stdio: "ignore" });
    lockCompletion = new Promise(resolve => { lock!.once("exit", resolve); lock!.once("error", () => resolve(-1)); });
    await waitFor(held);
    await waitFor(attempted);
    const cleanupStarted = performance.now();
    if (release) await writeFile(unlock, "release");
    const result = await running;
    if (release && exitCode === 0) expect(result.result).toMatchObject({ source: "manager", args: ["uninstall"] });
    else expect(result.error).toMatchObject({ code: exitCode || 1 });
    if (release) await expect(readFile(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    else {
      expect(result.error?.stderr).toContain("Maintenance temporary cleanup failed");
      expect(result.error?.stderr).toContain(dirname(runtime));
      expect((await stat(runtime)).isFile()).toBe(true);
      expect(performance.now() - cleanupStarted).toBeGreaterThanOrEqual(4_500);
      expect(performance.now() - cleanupStarted).toBeLessThan(15_000);
    }
    expect(await readFile(join(test.manager, "runmesh.cjs"), "utf8")).toContain("lock-ready.json");
  } finally {
    try { await writeFile(unlock, "release"); await running; }
    finally {
      try {
        if (lockCompletion !== undefined) {
          let code = await waitForLockExit(lockCompletion);
          if (code === undefined) { lock!.kill(); code = await waitForLockExit(lockCompletion); }
          expect(code, "the fixture's file-lock holder must exit").toBe(0);
        }
      } finally {
        try {
          // Only this invocation's exact generated runtime may be removed.
          if (runtime !== undefined) {
            const directory = dirname(runtime);
            expect(dirname(directory).toLowerCase()).toBe((await realpath(tmpdir())).toLowerCase());
            expect(basename(directory)).toMatch(/^runmesh-maintenance-[a-f0-9]{32}$/u);
            await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
          }
        } finally { await test.cleanup(); }
      }
    }
  }
}, 60000);

it.runIf(process.platform === "win32")("reports other Windows cleanup I/O errors immediately instead of retrying them", async () => {
  const test = await fixture(), attempted = join(test.temporary, "cleanup-attempted");
  const deletion = "[IO.Directory]::Delete($temporary,$true)";
  const probe = attempted.replaceAll("'", "''");
  await writeFile(join(test.manager, "uninstall.ps1"), renderWindowsMaintenanceUninstall().replace(deletion,
    `[IO.File]::AppendAllText('${probe}', $temporary+[Environment]::NewLine); throw [IO.IOException]::new('test non-sharing I/O failure', -2147024883)`));
  let directory: string | undefined;
  try {
    await expect(test.run(["uninstall"])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("test non-sharing I/O failure") });
    const attempts = (await readFile(attempted, "utf8")).trim().split(/\r?\n/u);
    expect(attempts).toHaveLength(1);
    directory = attempts[0]!;
    expect((await stat(join(directory, "node.exe"))).isFile()).toBe(true);
  } finally {
    if (directory !== undefined) {
      expect(dirname(directory).toLowerCase()).toBe((await realpath(tmpdir())).toLowerCase());
      expect(basename(directory)).toMatch(/^runmesh-maintenance-[a-f0-9]{32}$/u);
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
    await test.cleanup();
  }
}, 60000);
