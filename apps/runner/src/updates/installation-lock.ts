import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { trustedWindowsEnvironment, resolveTrustedWindowsTool, trustedWindowsRoot } from "../windows-tools.js";

export interface InstallationLease { release(): Promise<void>; assertHeld(): void; }
const code = (error: unknown): string | undefined => error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;

const uuidPattern = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const markerPattern = new RegExp(`^owner-([1-9][0-9]*)-(${uuidPattern})$`, "u");
const generationPattern = new RegExp(`^${uuidPattern}$`, "u");
const missing = (error: unknown) => code(error) === "ENOENT";
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); }
}
async function removeGeneration(directory: string, marker: string): Promise<void> {
  await unlink(join(directory, marker)); await unlink(join(directory, "lease.json")); await rmdir(directory);
}

/** The owner marker is renamed, never overwritten. Only the successful rename
 * may clear a dead generation, so competing recovery cannot unlink a new lock. */
async function recoverFileLease(path: string): Promise<void> {
  const info = await lstat(path).catch(error => missing(error) ? undefined : Promise.reject(error));
  if (info === undefined || info.isDirectory()) return; // A hosted installer owns a directory lock.
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("Runner installation lock is invalid.");
  const raw = await readFile(path, "utf8").catch(error => missing(error) ? undefined : Promise.reject(error));
  if (raw === undefined) return;
  const value = JSON.parse(raw) as { schema_version?: unknown; generation?: unknown };
  if (value.schema_version !== 1 || typeof value.generation !== "string" || !generationPattern.test(value.generation)) throw new Error("Runner installation lock is invalid.");
  const directory = `${path}.manager-${value.generation}`;
  const directoryInfo = await lstat(directory).catch(error => missing(error) ? undefined : Promise.reject(error));
  if (directoryInfo === undefined) return;
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Runner installation lock is invalid.");
  const entries: string[] = await readdir(directory).catch(error => missing(error) ? [] : Promise.reject(error));
  const markers = entries.filter(name => markerPattern.test(name));
  if (markers.length !== 1 || entries.length !== 2 || !entries.includes("lease.json")) return;
  const oldMarker = markers[0]!; const pid = Number(markerPattern.exec(oldMarker)![1]);
  if (!Number.isSafeInteger(pid)) return;
  try { process.kill(pid, 0); return; } catch (error) { if (code(error) !== "ESRCH") return; }
  const marker = `owner-${process.pid}-${randomUUID()}`;
  try { await rename(join(directory, oldMarker), join(directory, marker)); }
  catch (error) { if (missing(error)) return; throw error; }
  try {
    const lease = await lstat(join(directory, "lease.json"));
    const shared = await lstat(path).catch(error => missing(error) ? undefined : Promise.reject(error));
    if (shared !== undefined && shared.isFile() && !shared.isSymbolicLink() && shared.dev === lease.dev && shared.ino === lease.ino) {
      await unlink(path); await syncDirectory(dirname(path));
    }
    await removeGeneration(directory, marker);
  } catch (error) {
    // Failed recovery must not leave an unreturned live-PID claim. This unique
    // source still belongs to us; restoring the dead marker permits a retry.
    await rename(join(directory, marker), join(directory, oldMarker)).catch(() => undefined);
    throw error;
  }
}

async function directoryLease(path: string): Promise<InstallationLease | undefined> {
  await recoverFileLease(path);
  const generation = randomUUID(); const directory = `${path}.manager-${generation}`;
  const marker = `owner-${process.pid}-${randomUUID()}`; const ownerPath = join(directory, marker); const leasePath = join(directory, "lease.json");
  // Prepare the complete owner record before publishing a no-replace hardlink.
  // A crash at any earlier point leaves only an unreferenced private directory.
  await mkdir(directory, { mode: 0o700 });
  const handle = await open(leasePath, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ schema_version: 1, generation })); await handle.sync(); } finally { await handle.close(); }
  await writeFile(ownerPath, "", { flag: "wx", mode: 0o600 }); await syncDirectory(directory);
  const leaseInfo = await lstat(leasePath);
  try { await link(leasePath, path); }
  catch (error) { await removeGeneration(directory, marker); if (code(error) === "EEXIST") return undefined; throw error; }
  let held = true;
  const assertHeld = () => {
    if (!held) throw new Error("Runner installation lock was released.");
    const current = lstatSync(path); const owner = lstatSync(ownerPath);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== leaseInfo.dev || current.ino !== leaseInfo.ino || !owner.isFile() || owner.isSymbolicLink()) throw new Error("Runner installation lock owner changed.");
  };
  const lease: InstallationLease = { assertHeld, async release() {
    if (!held) return; assertHeld();
    // Removing the shared name first avoids a published ownerless lock.
    await unlink(path); held = false; await syncDirectory(dirname(path)); await removeGeneration(directory, marker);
  } };
  try { await syncDirectory(dirname(path)); return lease; }
  catch (error) { await lease.release().catch(() => undefined); throw error; }
}

async function windowsLease(name: string): Promise<InstallationLease | undefined> {
  // The helper owns the same OS mutex as install.ps1. EOF releases it even if
  // the manager crashes; a dead helper invalidates the lease before mutation.
  const script = `$ErrorActionPreference='Stop'; $m=[Threading.Mutex]::new($false,'${name}'); $held=$false; try { try { $held=$m.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held=$true }; if(-not $held) { [Console]::Out.WriteLine('busy'); exit 0 }; [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { if($held) { $m.ReleaseMutex() }; $m.Dispose() }`;
  const systemRoot = trustedWindowsRoot();
  const child = spawn(resolveTrustedWindowsTool("powershell.exe", systemRoot), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, env: trustedWindowsEnvironment(systemRoot), stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => undefined);
  let held = false; let closed = false;
  const exited = new Promise<void>(resolve => { child.once("close", () => { held = false; closed = true; resolve(); }); child.once("error", () => { held = false; closed = true; resolve(); }); });
  child.stderr.on("data", () => undefined);
  const ready = await new Promise<boolean>((resolve, reject) => {
    let stdout = ""; let settled = false;
    const finish = (value: boolean | Error) => { if (settled) return; settled = true; clearTimeout(timer); value instanceof Error ? reject(value) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error("Runner installer lock could not be acquired.")); }, 10000);
    child.once("error", () => finish(new Error("Runner installer lock helper could not start.")));
    child.once("close", () => finish(stdout.trim() === "busy" ? false : new Error("Runner installer lock helper exited.")));
    child.stdout.on("data", (bytes: Buffer) => {
      stdout += bytes.toString("utf8");
      if (stdout.length > 128) { child.kill(); finish(new Error("Runner installer lock helper returned invalid data.")); }
      else if (stdout.includes("\n")) {
        if (stdout.trim() === "held") { held = true; finish(true); }
        else if (stdout.trim() === "busy") finish(false);
        else { child.kill(); finish(new Error("Runner installer lock helper returned invalid data.")); }
      }
    });
  });
  if (!ready) { child.stdin.end(); await exited; return undefined; }
  return {
    assertHeld() { if (!held || closed) throw new Error("Runner installer lock helper stopped."); },
    async release() {
      if (closed) return;
      held = false; child.stdin.end("release\n");
      const timer = setTimeout(() => child.kill(), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
}

/** Acquire only for an update transaction; ordinary polling never holds the installer lock. */
export async function acquireInstallationLock(mode: "system" | "user", installRoot: string): Promise<InstallationLease | undefined> {
  if (process.platform === "win32") {
    const scope = createHash("sha256").update(resolve(installRoot).toLowerCase()).digest("hex");
    return windowsLease(mode === "system" ? "Global\\RunmeshInstaller-v1" : `Global\\RunmeshInstaller-user-${scope}`);
  }
  if (mode === "user") return directoryLease(join(installRoot, ".installation.lock"));
  return directoryLease("/var/run/runmesh-installer.lock");
}
