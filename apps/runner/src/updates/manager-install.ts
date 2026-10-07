import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ServiceCommandExecutor, ServiceMode, ServicePlatform } from "../service.js";
import { hostServiceCommandExecutor, isManagedService } from "../service.js";
import { escapeSystemdArgument, escapeXml } from "../services/escaping.js";
import { ownedManifest, parseOwnedManifest } from "../services/manifest-ownership.js";
import { refreshNativeServiceBody, renderWindowsDaemonTask, sameWindowsTaskDefinition } from "../services/native-template.js";
import { nativeProbeReliable } from "../services/probes.js";
import { hasStandardEffectiveMaintenanceLaunch, hasStandardMaintenanceLaunch, maintenanceLayout } from "./native-service.js";
import { renderManagedLauncher, renderWindowsMaintenanceUninstall } from "./launchers.js";
import type { MaintenanceLayout } from "./native-service.js";
import { trustedWindowsEnvironment, trustedWindowsRoot } from "../windows-tools.js";

export interface MaintenanceManagerFileStat {
  readonly file: boolean;
  readonly directory: boolean;
  readonly symlink: boolean;
  readonly uid: number;
  readonly mode: number;
}

/** All mutations are injectable; unit tests never register a service on the host. */
export interface MaintenanceManagerFilesystem {
  read(path: string): Promise<string | undefined>;
  stat(path: string): Promise<MaintenanceManagerFileStat | undefined>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, mode: number): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  symlink(source: string, destination: string): Promise<void>;
}

export interface MaintenanceManagerOptions {
  readonly platform?: ServicePlatform;
  readonly mode?: ServiceMode;
  readonly profilePath: string;
  readonly installRoot: string;
  readonly home?: string;
  readonly uid?: number;
  readonly executor?: ServiceCommandExecutor;
  readonly filesystem?: MaintenanceManagerFilesystem;
  /** Ordinary service removal retains the stable CLI for a later reinstall. */
  readonly preservePackage?: boolean;
}

export interface MaintenanceManagerInstaller {
  install(options: MaintenanceManagerOptions): Promise<MaintenanceManagerInstallResult | void>;
  uninstall(options: MaintenanceManagerOptions): Promise<void>;
}

export interface MaintenanceManagerInstallResult {
  readonly enabled: boolean;
  readonly reason?: "custom_service_layout";
}

const missing = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const hostFilesystem: MaintenanceManagerFilesystem = {
  read: path => readFile(path, "utf8").catch(error => missing(error) ? undefined : Promise.reject(error)),
  stat: async path => {
    const value = await lstat(path).catch(error => missing(error) ? undefined : Promise.reject(error));
    return value === undefined ? undefined : { file: value.isFile(), directory: value.isDirectory(), symlink: value.isSymbolicLink(), uid: value.uid, mode: value.mode };
  },
  realpath,
  mkdir: async (path, mode) => { await mkdir(path, { mode }); },
  copy: (source, destination) => copyFile(source, destination, constants.COPYFILE_EXCL),
  write: (path, content) => writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 }),
  rename,
  remove: path => rm(path, { recursive: true, force: true }),
  chmod,
  symlink: (source, destination) => symlink(source, destination),
};

const LINUX_MANAGER = "runmesh-manager.service";
const MAC_MANAGER = "io.alone.runmesh.manager";
const WINDOWS_MANAGER = "RunmeshManager";
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function sourceHelp(runtime: string, bundle: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = process.platform === "win32" ? trustedWindowsEnvironment(trustedWindowsRoot()) : { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
    const child = execFile(runtime, [bundle, "--help"], { cwd, env, windowsHide: true, timeout: 10_000, maxBuffer: 65_536, encoding: "utf8" }, (error, stdout) => error === null ? resolve(stdout) : reject(new Error("maintenance source cannot execute its help command")));
    child.stdin?.end();
  });
}

export interface MaintenanceManagerLayout extends MaintenanceLayout {
  readonly managerRoot: string;
  readonly manifestPath: string;
  readonly runtimePath: string;
  readonly bundlePath: string;
}

export function maintenanceManagerLayout(options: MaintenanceManagerOptions): MaintenanceManagerLayout {
  const result = maintenanceLayout(options);
  const { platform, path, layout } = result;
  const managerRoot = path.join(layout.installRoot, "manager");
  const manifestPath = path.join(path.dirname(layout.manifestPath), platform === "linux" ? LINUX_MANAGER : platform === "darwin" ? `${MAC_MANAGER}.plist` : `${WINDOWS_MANAGER}.xml`);
  return { ...result, managerRoot, manifestPath, runtimePath: path.join(managerRoot, "runtime", platform === "win32" ? "node.exe" : "node"), bundlePath: path.join(managerRoot, "runmesh.cjs") };
}

export function renderMaintenanceManager(options: MaintenanceManagerOptions): { path: string; content: string } {
  const { platform, mode, runtimePath, bundlePath, manifestPath, layout } = maintenanceManagerLayout(options);
  const invocation = [runtimePath, bundlePath, "maintenance-agent", "--profile", options.profilePath, "--install-root", layout.installRoot, ...(mode === "user" ? ["--user"] : [])];
  let body: string;
  if (platform === "linux") {
    // No User= in a system manager: only this controlled maintenance program
    // runs as root. The Runner's dedicated account and unit remain unchanged.
    body = `[Unit]\nDescription=Runmesh maintenance manager\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${invocation.map(escapeSystemdArgument).join(" ")}\nRestart=on-failure\nRestartSec=30s\n\n[Install]\nWantedBy=${mode === "system" ? "multi-user.target" : "default.target"}\n`;
  } else if (platform === "darwin") {
    body = `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${MAC_MANAGER}</string><key>ProgramArguments</key><array>${invocation.map(value => `<string>${escapeXml(value)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`;
  } else {
    body = renderWindowsDaemonTask({ description: "Runmesh maintenance manager", mode, invocation, systemAccount: "SYSTEM" });
  }
  return { path: manifestPath, content: ownedManifest(body, platform, "maintenance").content };
}

function managedManager(content: string): boolean {
  return parseOwnedManifest(content, "maintenance") !== undefined;
}

function managerHost(options: MaintenanceManagerOptions) {
  const layout = maintenanceManagerLayout(options);
  const filesystem = options.filesystem ?? hostFilesystem;
  const executor = options.executor ?? hostServiceCommandExecutor;
  const prefix = layout.mode === "user" ? ["--user"] : [];
  const uid = options.uid ?? process.getuid?.();
  if (layout.platform === "darwin" && layout.mode === "user" && uid === undefined) throw new Error("user manager installation requires the owning session UID");
  const domain = layout.mode === "system" ? "system" : `gui/${uid}`;
  const target = `${domain}/${MAC_MANAGER}`;
  const execute = async (file: string, args: readonly string[]) => {
    const result = await executor.execute(file, args);
    if (result.exitCode !== 0) throw new Error(`maintenance manager command failed: ${file} ${args[0] ?? ""}`);
    return result;
  };
  const ps = (script: string) => execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const checkedAcls = new Set<string>();
  const trusted = async (file: string, kind: "directory" | "file", ancestor = false) => {
    const info = await filesystem.stat(file);
    if (info === undefined || info.symlink || !info[kind]) throw new Error("maintenance manager path is missing, linked or has the wrong type");
    if (layout.platform !== "win32") {
      const owner = layout.mode === "system" ? 0 : uid;
      if (owner === undefined || (info.uid !== owner && !(ancestor && info.uid === 0)) || (info.mode & 0o022) !== 0) throw new Error("maintenance manager path is not owned exclusively by its administrator");
    } else if (layout.mode === "system" && !checkedAcls.has(`${file}:${ancestor}`)) {
      // A root/SYSTEM maintenance agent must never execute a package (or read
      // a credential) that Local Service or another restricted account can edit.
      const ancestorWrite = ancestor ? "" : "[Security.AccessControl.FileSystemRights]::Write -bor ";
      await ps(`$ErrorActionPreference='Stop'; $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=[Security.Principal.WindowsPrincipal]::new($identity); if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Manager installation requires an administrator' }; $allowed=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',$identity.User.Value); $acl=Get-Acl -LiteralPath ${psQuote(file)}; $owner=([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value; if($allowed -notcontains $owner) { throw 'Manager path owner is not trusted' }; $write=${ancestorWrite}[Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership; foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if(($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($ace.FileSystemRights -band $write) -ne 0 -and $allowed -notcontains $ace.IdentityReference.Value) { throw 'Manager path is writable by another identity' } }`);
      checkedAcls.add(`${file}:${ancestor}`);
    }
  };
  const trustedTreePath = async (file: string, kind: "directory" | "file", boundary: string) => {
    const relative = layout.path.relative(boundary, file);
    if (relative === ".." || relative.startsWith(`..${layout.path.sep}`) || layout.path.isAbsolute(relative)) throw new Error("maintenance path escapes its trusted root");
    const canonical = await filesystem.realpath(file);
    const equivalent = layout.platform === "win32" ? canonical.toLowerCase() === layout.path.normalize(file).toLowerCase() : canonical === file;
    if (!equivalent) throw new Error("maintenance path follows an unexpected link");
    await trusted(file, kind);
    let parent = kind === "directory" ? file : layout.path.dirname(file);
    while (true) {
      if (parent !== file) await trusted(parent, "directory");
      if (parent === boundary) break;
      const next = layout.path.dirname(parent);
      if (parent === next) throw new Error("maintenance path does not reach its trusted root");
      parent = next;
    }
    // Trust must extend above the configured root: a writable parent could
    // replace an otherwise private directory after the first observation.
    parent = layout.path.dirname(boundary);
    while (parent !== boundary) {
      await trusted(parent, "directory", true);
      const next = layout.path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  };
  const registered = async () => {
    const result = layout.platform === "linux" ? await executor.execute("systemctl", [...prefix, "show", LINUX_MANAGER, "--property=LoadState", "--value"])
      : layout.platform === "darwin" ? await executor.execute("launchctl", ["print", target])
        : await ps("$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); try { $t=$s.GetFolder('\\').GetTask('RunmeshManager'); [Console]::Write('present') } catch { $e=$_.Exception; while($null -ne $e) { if($e.HResult -eq -2147024894) { [Console]::Write('absent'); exit 0 }; $e=$e.InnerException }; throw }");
    if (layout.platform === "linux") {
      if (result.exitCode !== 0) throw new Error("maintenance manager registration could not be inspected");
      const load = result.stdout?.trim();
      if (load !== "loaded" && load !== "not-found" && load !== "masked") throw new Error("maintenance manager registration is unknown");
      return load !== "not-found";
    }
    if (layout.platform === "darwin") {
      if (!nativeProbeReliable(result, "query")) throw new Error("maintenance manager registration could not be inspected");
      return result.exitCode === 0;
    }
    if (result.stdout?.trim() !== "present" && result.stdout?.trim() !== "absent") throw new Error("maintenance manager registration is unknown");
    return result.stdout.trim() === "present";
  };
  const stop = async () => {
    if (!await registered()) return;
    if (layout.platform === "linux") {
      await execute("systemctl", [...prefix, "disable", "--now", LINUX_MANAGER]);
      const stopped = await execute("systemctl", [...prefix, "show", LINUX_MANAGER, "--property=ActiveState,MainPID"]);
      if (!/^ActiveState=(inactive|failed)\r?$/mu.test(stopped.stdout ?? "") || !/^MainPID=0\r?$/mu.test(stopped.stdout ?? "")) throw new Error("maintenance manager did not stop");
    } else if (layout.platform === "darwin") {
      const live = await execute("launchctl", ["print", target]);
      const pid = /\bpid\s*=\s*(\d+)/u.exec(live.stdout ?? "")?.[1];
      if (/\bstate\s*=\s*running\b/u.test(live.stdout ?? "") && pid === undefined) throw new Error("maintenance manager process identity is unavailable");
      await execute("launchctl", ["disable", target]);
      await execute("launchctl", ["bootout", target]);
      if (await registered()) throw new Error("maintenance manager did not unload");
      if (pid !== undefined && Number(pid) > 0) {
        const deadline = Date.now() + 5_000;
        while (true) {
          const processState = await executor.execute("ps", ["-p", pid, "-o", "pid="]);
          if (processState.exitCode === 1 && !(processState.stdout ?? "").trim() && !(processState.stderr ?? "").trim()) break;
          if (processState.exitCode !== 0 || Date.now() >= deadline) throw new Error("maintenance manager process has not exited");
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } else {
      await ps("$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $t=$s.GetFolder('\\').GetTask('RunmeshManager'); $t.Enabled=$false; $t.Stop(0); $deadline=[DateTime]::UtcNow.AddSeconds(5); do { $t=$s.GetFolder('\\').GetTask('RunmeshManager'); if(($t.GetInstances(0)).Count -eq 0 -and ([int]$t.State -eq 1 -or [int]$t.State -eq 3)) { exit 0 }; if([DateTime]::UtcNow -ge $deadline) { throw 'Maintenance manager is still running' }; [Threading.Thread]::Sleep(100) } while($true)");
    }
  };
  return { ...layout, filesystem, executor, prefix, domain, target, execute, ps, trusted, trustedTreePath, registered, stop };
}

async function installManagementLaunchers(host: ReturnType<typeof managerHost>, onRollback: (rollback: () => Promise<void>) => void): Promise<void> {
  const { filesystem, path, layout, platform } = host;
  const current = path.join(layout.installRoot, "current");
  if (!(await filesystem.stat(current))?.symlink) throw new Error("managed current must be a link");
  const version = await filesystem.realpath(current); const versions = path.join(layout.installRoot, "versions");
  const relative = path.relative(versions, version);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error("managed current escapes its versions directory");
  await host.trustedTreePath(version, "directory", layout.installRoot);
  const names = platform === "win32" ? ["runmesh.cmd", "runmesh-runner.cmd"] : ["bin/runmesh", "bin/runmesh-runner"];
  const wrapper = renderManagedLauncher(platform, layout.installRoot);
  const packageBundle = platform === "win32" ? path.join(version, "runmesh.cjs") : path.join(version, "lib", "node_modules", "@aloneio", "runmesh-runner", "dist", "runmesh.cjs");
  const changed: { destination: string; content: string | undefined; info: MaintenanceManagerFileStat | undefined }[] = [];
  const rollback = async () => {
    for (const previous of [...changed].reverse()) {
      if (await filesystem.read(previous.destination) !== wrapper) throw new Error("managed launcher changed during rollback");
      if (previous.info === undefined) { await filesystem.remove(previous.destination); continue; }
      const temporary = `${previous.destination}.${randomUUID()}.tmp`;
      try {
        if (previous.info.symlink) await filesystem.symlink(packageBundle, temporary);
        else {
          await filesystem.write(temporary, previous.content!);
          if (platform !== "win32") await filesystem.chmod(temporary, previous.info.mode & 0o777);
        }
        await filesystem.rename(temporary, previous.destination);
      } finally { await filesystem.remove(temporary).catch(() => undefined); }
    }
  };
  onRollback(rollback);
  for (const name of names) {
    const destination = path.join(version, ...name.split("/"));
    await host.trustedTreePath(path.dirname(destination), "directory", layout.installRoot);
    const existing = await filesystem.stat(destination);
    const content = existing === undefined ? undefined : await filesystem.read(destination);
    if (existing !== undefined) {
      if (existing.symlink) {
        if (await filesystem.realpath(destination) !== packageBundle) throw new Error("managed launcher points outside its package");
      } else await host.trustedTreePath(destination, "file", layout.installRoot);
      if (!existing.symlink && content === wrapper) continue;
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await filesystem.write(temporary, wrapper);
      if (platform !== "win32") await filesystem.chmod(temporary, 0o755);
      // Rename replaces an npm bin symlink itself, never its signed target.
      await filesystem.rename(temporary, destination);
      changed.push({ destination, content, info: existing });
    } finally { await filesystem.remove(temporary).catch(() => undefined); }
  }
}

/** Initial installation copies once. Runner package changes never overwrite a live manager. */
export async function managerInstall(options: MaintenanceManagerOptions): Promise<MaintenanceManagerInstallResult> {
  const host = managerHost(options);
  const { platform, mode, path, layout, filesystem, managerRoot, manifestPath, runtimePath, bundlePath } = host;
  const runnerManifest = await filesystem.read(layout.manifestPath);
  if (runnerManifest === undefined || !isManagedService(runnerManifest)) throw new Error("maintenance manager requires a managed Runner installation");
  // Existing custom service definitions remain supported by the ordinary CLI.
  if (!hasStandardMaintenanceLaunch(runnerManifest, options)) return { enabled: false, reason: "custom_service_layout" };
  if (!await hasStandardEffectiveMaintenanceLaunch(runnerManifest, options)) return { enabled: false, reason: "custom_service_layout" };
  await host.trustedTreePath(layout.installRoot, "directory", layout.installRoot);
  await host.trustedTreePath(layout.manifestPath, "file", path.dirname(layout.manifestPath));
  const profileBoundary = mode === "system" ? layout.configRoot : path.dirname(options.profilePath);
  await host.trustedTreePath(options.profilePath, "file", profileBoundary);
  const previousManifest = await filesystem.read(manifestPath);
  if (previousManifest !== undefined && !managedManager(previousManifest)) throw new Error("refusing to overwrite an unmanaged maintenance service");
  if (previousManifest !== undefined) await host.trustedTreePath(manifestPath, "file", path.dirname(manifestPath));
  if (previousManifest === undefined && await host.registered()) throw new Error("refusing to replace an unknown native maintenance service");
  const metadataPath = path.join(managerRoot, "installation.json");
  const metadata = JSON.stringify({ schema_version: 1, platform, mode, profile_path: options.profilePath, install_root: layout.installRoot });
  const existingRoot = await filesystem.stat(managerRoot);
  let created = false;
  let serviceAttempted = false;
  let rollbackLaunchers: (() => Promise<void>) | undefined;
  const rendered = renderMaintenanceManager(options);
  let manifest = rendered;
  if (previousManifest !== undefined) {
    const previous = parseOwnedManifest(previousManifest, "maintenance")!;
    const body = refreshNativeServiceBody(previous.body, platform);
    const expected = parseOwnedManifest(rendered.content, "maintenance")!.body;
    if (body !== expected && !(platform === "win32" && sameWindowsTaskDefinition(body, expected))) throw new Error("maintenance manager definition differs from this installation");
    manifest = { path: manifestPath, content: body === previous.body ? previousManifest : ownedManifest(body, platform, "maintenance", previous.newline).content };
  }
  const wasRegistered = platform === "win32" && previousManifest !== undefined ? await host.registered() : false;
  let manifestWriteAttempted = false, nativeDefinitionAttempted = false;
  const temporary = `${managerRoot}.staging.${randomUUID()}`;
  const temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    if (existingRoot !== undefined) {
      await host.trustedTreePath(runtimePath, "file", layout.installRoot);
      await host.trustedTreePath(bundlePath, "file", layout.installRoot);
      await host.trustedTreePath(metadataPath, "file", layout.installRoot);
      if (await filesystem.read(metadataPath) !== metadata) throw new Error("maintenance manager belongs to a different installation");
    } else {
      const current = path.join(layout.installRoot, "current");
      if ((await filesystem.stat(current))?.symlink !== true) throw new Error("maintenance manager requires the managed current link");
      const version = await filesystem.realpath(current);
      const versionsRoot = path.join(layout.installRoot, "versions");
      const relative = path.relative(versionsRoot, version);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error("managed current link escapes the versions directory");
      await host.trusted(versionsRoot, "directory");
      await host.trusted(version, "directory");
      const sourceRuntime = path.join(version, "runtime", platform === "win32" ? "node.exe" : "node");
      // Only the signed maintenance artifact may seed the independent manager.
      // The ordinary Runner entry can be broken without affecting this program.
      const packageRoot = platform === "win32" ? path.join(version, "node_modules", "@aloneio", "runmesh-runner") : path.join(version, "lib", "node_modules", "@aloneio", "runmesh-runner");
      const sourceBundle = path.join(packageRoot, "dist", "maintenance.cjs");
      if (await filesystem.stat(sourceBundle) === undefined) throw new Error("current Runner package lacks its independent maintenance artifact; install a compatible verified Runner package first");
      for (const source of [sourceRuntime, sourceBundle]) {
        await host.trustedTreePath(source, "file", layout.installRoot);
      }
      const help = options.executor === undefined ? await sourceHelp(sourceRuntime, sourceBundle, version)
        : (await host.execute(sourceRuntime, [sourceBundle, "--help"])).stdout ?? "";
      if (!/(?:^|[\s|<])maintenance-agent(?:[\s|>]|$)/u.test(help)) throw new Error("current maintenance artifact does not support maintenance-agent; install a compatible verified Runner package first");
      await filesystem.mkdir(temporary, 0o700);
      await filesystem.mkdir(path.join(temporary, "runtime"), 0o700);
      await filesystem.copy(sourceRuntime, path.join(temporary, "runtime", path.basename(runtimePath)));
      await filesystem.copy(sourceBundle, path.join(temporary, "runmesh.cjs"));
      await filesystem.write(path.join(temporary, "installation.json"), metadata);
      if (platform === "win32") {
        const grants = mode === "system" ? ["BUILTIN\\Administrators:(OI)(CI)F", "NT AUTHORITY\\SYSTEM:(OI)(CI)F"] : undefined;
        if (grants !== undefined) await host.ps(`$ErrorActionPreference='Stop'; & icacls ${psQuote(temporary)} /inheritance:r /grant:r ${grants.map(psQuote).join(" ")} /T | Out-Null; if($LASTEXITCODE -ne 0) { throw 'Manager ACL setup failed' }`);
      } else {
        await filesystem.chmod(path.join(temporary, "runtime", path.basename(runtimePath)), 0o700);
        await filesystem.chmod(path.join(temporary, "runmesh.cjs"), 0o600);
      }
      await filesystem.rename(temporary, managerRoot);
      created = true;
    }
    // Refresh only the known generated fields; retain explicit operator settings
    // and the already installed independent manager program.
    if (previousManifest !== manifest.content) {
      if (await filesystem.read(manifestPath) !== previousManifest) throw new Error("maintenance manager definition changed during installation");
      manifestWriteAttempted = true;
      await filesystem.write(temporaryManifest, manifest.content);
      await filesystem.rename(temporaryManifest, manifestPath);
    }
    if (platform === "win32") {
      const helper = path.join(managerRoot, "uninstall.ps1");
      if (await filesystem.stat(helper) === undefined) await filesystem.write(helper, renderWindowsMaintenanceUninstall());
      await host.trustedTreePath(helper, "file", layout.installRoot);
      if (await filesystem.read(helper) !== renderWindowsMaintenanceUninstall()) throw new Error("maintenance uninstall helper differs from this installation");
    }
    await installManagementLaunchers(host, rollback => { rollbackLaunchers = rollback; });
    serviceAttempted = true;
    if (platform === "linux") {
      await host.execute("systemctl", [...host.prefix, "daemon-reload"]);
      await host.execute("systemctl", [...host.prefix, "enable", "--now", LINUX_MANAGER]);
      await host.execute("systemctl", [...host.prefix, "is-active", "--quiet", LINUX_MANAGER]);
    } else if (platform === "darwin") {
      await host.execute("launchctl", ["enable", host.target]);
      if (!await host.registered()) await host.execute("launchctl", ["bootstrap", host.domain, manifestPath]);
      await host.execute("launchctl", ["kickstart", host.target]);
    } else {
      const registered = await host.registered();
      if (manifestWriteAttempted || !registered) {
        nativeDefinitionAttempted = true;
        await host.execute("schtasks", ["/Create", "/TN", WINDOWS_MANAGER, "/XML", manifestPath, ...(registered ? ["/F"] : [])]);
      }
      await host.execute("schtasks", ["/Change", "/TN", WINDOWS_MANAGER, "/ENABLE"]);
      await host.execute("schtasks", ["/Run", "/TN", WINDOWS_MANAGER]);
    }
    return { enabled: true };
  } catch (cause) {
    // Restore the exact prior bytes only while this attempt still owns them.
    // Updating an existing task does not replace or stop its running manager.
    if (previousManifest !== undefined && manifestWriteAttempted) {
      try {
        if (await filesystem.read(manifestPath) === manifest.content) {
          await filesystem.remove(temporaryManifest);
          await filesystem.write(temporaryManifest, previousManifest);
          await filesystem.rename(temporaryManifest, manifestPath);
          if (nativeDefinitionAttempted && wasRegistered) await host.execute("schtasks", ["/Create", "/TN", WINDOWS_MANAGER, "/XML", manifestPath, "/F"]);
        }
      } catch { /* Preserve the independent package and the original failure. */ }
    }
    // Only a new manager belongs to this attempt. Preserve an existing one and
    // leave its independent package available for recovery after any failure.
    let launchersRestored = true;
    if (rollbackLaunchers !== undefined) { try { await rollbackLaunchers(); } catch { launchersRestored = false; } }
    if (created) {
      let stopped = !serviceAttempted;
      if (serviceAttempted) { try { await host.stop(); stopped = true; } catch { /* retain executable while its process may still exist */ } }
      if (stopped && launchersRestored) {
        if (platform === "win32" && serviceAttempted) await host.execute("schtasks", ["/Delete", "/TN", WINDOWS_MANAGER, "/F"]).catch(() => undefined);
        if (previousManifest === undefined && await filesystem.read(manifestPath) === manifest.content) await filesystem.remove(manifestPath).catch(() => undefined);
        await filesystem.remove(managerRoot).catch(() => undefined);
      }
    }
    throw cause;
  } finally {
    await filesystem.remove(temporary).catch(() => undefined);
    await filesystem.remove(temporaryManifest).catch(() => undefined);
  }
}

async function assertFinishedManagerJournal(host: ReturnType<typeof managerHost>): Promise<void> {
  const journalPath = host.path.join(host.managerRoot, "state", "active-operation.json");
  if (await host.filesystem.stat(journalPath) === undefined) return;
  await host.trustedTreePath(journalPath, "file", host.managerRoot);
  let journal: unknown;
  try { journal = JSON.parse(await host.filesystem.read(journalPath) ?? ""); } catch { throw new Error("maintenance journal is invalid; retain the manager for recovery"); }
  if (typeof journal !== "object" || journal === null || !("phase" in journal) || !["succeeded", "rolled_back", "failed"].includes(String(journal.phase))) {
    throw new Error("Runner maintenance is unfinished; recover it before uninstalling or purging the installation");
  }
}

/** Stop the independent manager before removing its package or purging Runner state. */
export async function managerUninstall(options: MaintenanceManagerOptions): Promise<void> {
  const host = managerHost(options);
  const existing = await host.filesystem.read(host.manifestPath);
  if (existing === undefined) {
    if (await host.filesystem.stat(host.managerRoot) !== undefined) {
      const metadata = host.path.join(host.managerRoot, "installation.json");
      await host.trustedTreePath(metadata, "file", host.layout.installRoot);
      const expected = JSON.stringify({ schema_version: 1, platform: host.platform, mode: host.mode, profile_path: options.profilePath, install_root: host.layout.installRoot });
      if (await host.filesystem.read(metadata) !== expected || await host.registered()) throw new Error("maintenance manager manifest is missing; refusing to remove an unverified package");
      await assertFinishedManagerJournal(host);
      if (!options.preservePackage) await host.filesystem.remove(host.managerRoot);
    }
    return;
  }
  if (!managedManager(existing)) throw new Error("refusing to remove an unmanaged maintenance service");
  await host.trustedTreePath(host.manifestPath, "file", host.path.dirname(host.manifestPath));
  await host.trustedTreePath(host.managerRoot, "directory", host.layout.installRoot);
  await host.stop();
  // Native stop releases the manager's installer lease before this read. A
  // crash or interrupted switch must keep its independent runtime and journal
  // available for recovery; uninstall/purge may not destroy that evidence.
  await assertFinishedManagerJournal(host);
  if (host.platform === "win32" && await host.registered()) await host.execute("schtasks", ["/Delete", "/TN", WINDOWS_MANAGER, "/F"]);
  if (await host.filesystem.read(host.manifestPath) !== existing) throw new Error("maintenance service changed during removal");
  await host.filesystem.remove(host.manifestPath);
  if (host.platform === "linux") await host.execute("systemctl", [...host.prefix, "daemon-reload"]);
  if (!options.preservePackage) await host.filesystem.remove(host.managerRoot);
}

export const hostMaintenanceManager: MaintenanceManagerInstaller = { install: managerInstall, uninstall: managerUninstall };
