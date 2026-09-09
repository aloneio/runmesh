import { constants } from "node:fs";
import { lstat, open, readFile, readlink, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { currentServicePlatform, hostServiceCommandExecutor, isManagedService, serviceLayout, type ServiceCommandExecutor, type ServiceMode, type ServicePlatform } from "./service.js";

/** Cleanup is restricted to these application-owned locations. */
export function purgeLayout(platform: ServicePlatform, mode: ServiceMode, home = homedir()) {
  const layout = serviceLayout({ platform, mode, home });
  const directories = [layout.logRoot, layout.stateRoot, layout.configRoot, layout.installRoot];
  const unitDirectories = platform === "linux"
    ? mode === "system" ? ["/etc/systemd/system", "/run/systemd/system", "/usr/local/lib/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"] : [dirname(layout.manifestPath)]
    : [];
  if (platform === "linux" && mode === "system") directories.push("/var/lib/runmesh-runner", "/etc/runmesh-runner", "/var/log/runmesh-runner", "/run/runmesh", "/run/runmesh-runner", "/var/run/runmesh", "/var/run/runmesh-runner");
  return { ...layout, directories: [...new Set(directories)], unitDirectories };
}

/** Injected in tests; no test performs host service or installation changes. */
export interface PurgeStat {
  readonly dev: number;
  readonly ino: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}
export interface PurgeFilesystem {
  stat(path: string): Promise<PurgeStat | undefined>;
  canonical(path: string): Promise<string>;
  list(path: string): Promise<string[]>;
  text(path: string, limit: number): Promise<string | undefined>;
  link(path: string): Promise<string>;
  file(path: string): Promise<void>;
  directory(path: string): Promise<void>;
  mounts(): Promise<string[]>;
  withDirectory?(path: string, expected: PurgeStat, action: (anchored: string) => Promise<void>): Promise<void>;
}
const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
export const hostPurgeFilesystem: PurgeFilesystem = {
  stat: async (path) => lstat(path).catch((error: unknown) => { if (missing(error)) return undefined; throw error; }),
  withDirectory: async (path, expected, action) => {
    if (process.platform !== "linux") {
      if (await realpath(path) !== path) throw new Error("directory alias changed during cleanup");
      await action(path); return;
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!same(expected, await handle.stat())) throw new Error("directory changed while pinning cleanup handle");
      await action(`/proc/self/fd/${handle.fd}`);
    } finally { await handle.close(); }
  },
  canonical: realpath,
  list: readdir,
  link: readlink,
  file: unlink,
  directory: rmdir,
  text: async (path, limit) => {
    let handle;
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error("unsafe or oversized metadata");
      handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("metadata changed while opening");
      const bytes = Buffer.alloc(limit + 1); let offset = 0;
      while (offset <= limit) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (bytesRead === 0) break; offset += bytesRead; }
      if (offset > limit) throw new Error("oversized metadata");
      return bytes.subarray(0, offset).toString("utf8");
    } catch (error) { if (missing(error)) return undefined; throw error; }
    finally { await handle?.close(); }
  },
  mounts: async () => process.platform !== "linux" ? [] : (await readFile("/proc/self/mountinfo", "utf8")).trim().split("\n").map((line) => (line.split(" ")[4] ?? "").replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))),
};

export interface PurgeResult {
  readonly action: "uninstall";
  readonly purged: boolean;
  readonly removed: string[];
  readonly absent: string[];
  readonly failures: { path: string; reason: string }[];
  readonly preserved: string[];
}
export interface PurgeOptions {
  readonly platform?: ServicePlatform;
  readonly mode?: ServiceMode;
  readonly home?: string;
  readonly filesystem?: PurgeFilesystem;
  readonly executor?: ServiceCommandExecutor;
  readonly progress?: (message: string) => void;
}
const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const same = (a: PurgeStat, b: PurgeStat | undefined) => b !== undefined && a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory() && a.isSymbolicLink() === b.isSymbolicLink();

export async function purgeInstallation(options: PurgeOptions = {}): Promise<PurgeResult> {
  const platform = options.platform ?? currentServicePlatform(); const mode = options.mode ?? "system";
  const io = options.filesystem ?? hostPurgeFilesystem; const executor = options.executor ?? hostServiceCommandExecutor;
  const layout = purgeLayout(platform, mode, options.home);
  const progress = options.progress ?? (() => undefined);
  const result: PurgeResult = { action: "uninstall", purged: false, removed: [], absent: [], failures: [], preserved: ["project workspaces", "system accounts", "shared system journal", "other users' installations"] };
  const paths = new Set<string>(); const mounts = await io.mounts();
  const errors = (path: string, error: unknown) => result.failures.push({ path, reason: error instanceof Error ? error.message : "cleanup failed" });
  const acceptedAlias = (path: string, target: string) => {
    if (platform === "darwin" && path === "/var") return target === "/private/var";
    if (platform === "linux" && path === "/var/run") return target === "/run";
    if (platform === "linux" && path === "/lib") return target === "/usr/lib";
    return false;
  };
  async function safeParent(path: string): Promise<string | undefined> {
    const parent = dirname(path); const chain: string[] = []; let p = parent;
    while (dirname(p) !== p) { chain.unshift(p); p = dirname(p); }
    for (const part of chain) {
      const info = await io.stat(part); if (!info) return undefined;
      if (info.isSymbolicLink()) { const target = await io.canonical(part); if (!acceptedAlias(part, target)) throw new Error("refusing a symlinked ancestor"); }
      else if (!info.isDirectory()) throw new Error("parent is not a directory");
    }
    return join(await io.canonical(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
  async function add(path: string) {
    const safe = await safeParent(path);
    if (safe === undefined || !await io.stat(safe)) { result.absent.push(path); return; }
    paths.add(safe);
  }
  progress("[1/4] Checking Runmesh installation");
  for (const path of layout.directories) { try { await add(path); } catch (error) { errors(path, error); } }
  const manifests: string[] = [];
  for (const dir of layout.unitDirectories) {
    const unit = join(dir, "runmesh-runner.service");
    try {
      const safe = await safeParent(unit); if (!safe) continue;
      const info = await io.stat(safe);
      if (info?.isFile() && !info.isSymbolicLink()) {
        const body = await io.text(safe, 128 * 1024) ?? "";
        if (!isManagedService(body) && !/^ExecStart\s*=\s*"?\/opt\/runmesh\//m.test(body)) throw new Error("same-named service is not owned by Runmesh");
        manifests.push(safe);
      } else if (info?.isSymbolicLink()) {
        const target = await io.link(safe);
        if (target !== "/dev/null" && !layout.unitDirectories.some((d) => resolve(dirname(safe), target) === join(d, "runmesh-runner.service"))) throw new Error("unit points outside Runmesh service locations");
      } else if (info) throw new Error("unexpected service file type");
      if (info) paths.add(safe);
      await add(join(dir, "runmesh-runner.service.d"));
      for (const entry of await io.list(dirname(safe))) {
        if (!/\.(?:wants|requires)$/.test(entry)) continue;
        const parent = join(dirname(safe), entry); const metadata = await io.stat(parent);
        if (!metadata?.isDirectory() || metadata.isSymbolicLink()) continue;
        const link = join(parent, "runmesh-runner.service"); const item = await io.stat(link);
        if (item?.isSymbolicLink()) paths.add(link);
        else if (item) throw new Error("unit enablement entry is not a symlink");
      }
    } catch (error) { errors(unit, error); }
  }
  if (platform !== "win32" && mode === "system") {
    for (const base of ["/usr/local/bin", "/usr/bin"]) for (const name of ["runmesh", "runmesh-runner"]) {
      const shim = join(base, name);
      try { const info = await io.stat(shim); if (info?.isSymbolicLink() && within(resolve(base, await io.link(shim)), layout.installRoot)) await add(shim); }
      catch (error) { errors(shim, error); }
    }
  }
  if (platform !== "linux") {
    try {
      const safe = await safeParent(layout.manifestPath);
      const info = safe === undefined ? undefined : await io.stat(safe);
      if (info && (info.isSymbolicLink() || !isManagedService(await io.text(safe!, 128 * 1024) ?? ""))) throw new Error("service manifest is not owned by Runmesh");
      if (safe && info) { paths.add(safe); manifests.push(safe); }
    } catch (error) { errors(layout.manifestPath, error); }
  }
  // Never erase a workspace nested inside an installation/state directory.
  for (const state of [layout.stateRoot, ...(platform === "linux" && mode === "system" ? ["/var/lib/runmesh-runner"] : [])]) {
    for (const name of ["active-policy.json", "previous-policy.json"]) {
      const path = join(state, "policy", name);
      try {
        const safe = await safeParent(path); if (!safe) continue;
        const text = await io.text(safe, 2 * 1024 * 1024); if (!text) continue;
        const policy = JSON.parse(text) as { workspaces?: { root_path?: unknown }[] };
        for (const workspace of policy.workspaces ?? []) {
          if (typeof workspace.root_path !== "string") continue;
          for (const target of paths) if (within(resolve(workspace.root_path), target)) errors(target, new Error("contains a configured workspace; move it before purging"));
        }
      } catch (error) { errors(path, error); }
    }
  }
  for (const path of paths) if (mounts.some((mount) => within(mount, path))) errors(path, new Error("contains a mounted filesystem; unmount it before purging"));
  if (result.failures.length) return result;
  const run = async (file: string, args: string[]) => {
    const response = await executor.execute(file, args);
    if (response.exitCode !== 0) throw new Error(`${file} command failed; installation files retained where possible`);
    return response.stdout ?? "";
  };
  progress("[2/4] Stopping the Runmesh service");
  let systemd = false;
  const prefix = mode === "user" ? ["--user"] : [];
  try {
    if (platform === "linux") {
      systemd = mode === "user" || await io.stat("/run/systemd/system") !== undefined;
      if (systemd) {
        const shown = await run("systemctl", [...prefix, "show", "runmesh-runner.service", "--property=LoadState,ActiveState,FragmentPath,ExecStart", "--no-pager"]);
        const fields = Object.fromEntries(shown.trim().split("\n").map((line) => { const n = line.indexOf("="); return [line.slice(0, n), line.slice(n + 1)]; }));
        if (fields.LoadState !== "not-found") {
          if (!fields.LoadState || !fields.ActiveState) throw new Error("cannot establish native service state");
          if (!manifests.length && fields.LoadState !== "masked" && !(fields.ExecStart ?? "").includes(layout.installRoot + "/")) throw new Error("unrecognized native service; refusing to stop it");
          await run("systemctl", [...prefix, "stop", "runmesh-runner.service"]);
          const disabled = await executor.execute("systemctl", [...prefix, "disable", "runmesh-runner.service"]);
          if (disabled.exitCode !== 0 && fields.LoadState !== "masked") throw new Error("could not disable Runmesh startup");
          const active = (await run("systemctl", [...prefix, "show", "runmesh-runner.service", "--property=ActiveState", "--value"])).trim();
          if (active !== "inactive" && active !== "failed") throw new Error("Runner has not stopped; files retained");
        }
      }
    } else if (platform === "darwin") {
      const target = mode === "system" ? "system/io.alone.runmesh.runner" : `gui/${process.getuid?.() ?? 0}/io.alone.runmesh.runner`;
      const found = await executor.execute("launchctl", ["print", target]);
      if (found.exitCode === 0) {
        if (!manifests.length || !(found.stdout ?? "").includes("runmesh")) throw new Error("unrecognized launchd registration");
        await run("launchctl", ["bootout", target]);
      } else if (![3, 113].includes(found.exitCode)) throw new Error("launchd status is unavailable");
    } else {
      const inspect = "$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); try {$t=$s.GetFolder('\\').GetTask('RunmeshRunner')} catch {if ($_.Exception.HResult -eq -2147024894) {Write-Output 'absent'; exit 0}; throw}; Write-Output 'present'";
      const state = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", inspect])).trim();
      if (state === "present") {
        if (!manifests.length) throw new Error("task exists without its managed manifest; restore the manifest before purging");
        const xml = await run("schtasks", ["/Query", "/TN", "RunmeshRunner", "/XML"]);
        if (!xml.toLowerCase().includes(layout.installRoot.toLowerCase())) throw new Error("task executable is outside the managed installation");
        await executor.execute("schtasks", ["/End", "/TN", "RunmeshRunner"]);
        await run("schtasks", ["/Delete", "/TN", "RunmeshRunner", "/F"]);
      } else if (state !== "absent") throw new Error("unexpected task status");
    }
  } catch (error) { errors(layout.manifestPath, error); return result; }
  progress("[3/4] Removing installation, configuration, state and logs");
  let visited = 0;
  async function removeTree(path: string, expected: PurgeStat, device: number, depth = 0): Promise<void> {
    if (++visited > 500_000 || depth > 128) throw new Error("cleanup traversal limit reached");
    if (!same(expected, await io.stat(path))) throw new Error("path changed during cleanup");
    if (expected.isSymbolicLink() || !expected.isDirectory()) { await io.file(path); return; }
    if (expected.dev !== device || mounts.includes(path)) throw new Error("refusing to cross a filesystem boundary");
    const enumerate = async (anchor: string) => {
      for (const name of await io.list(anchor)) {
        if (name === "." || name === ".." || name.includes(sep)) throw new Error("invalid directory entry");
        if (!same(expected, await io.stat(path))) throw new Error("directory changed during cleanup");
        const child = join(anchor, name); const info = await io.stat(child);
        if (info) await removeTree(child, info, device, depth + 1);
      }
    };
    if (io.withDirectory) await io.withDirectory(path, expected, enumerate);
    else {
      if (await io.canonical(path) !== path) throw new Error("directory alias changed during cleanup");
      await enumerate(path);
    }
    if (!same(expected, await io.stat(path))) throw new Error("directory changed during cleanup");
    await io.directory(path);
  }
  // An earlier failure leaves the installed maintenance CLI usable.
  const ordered = [...paths].sort((a, b) => Number(a === layout.installRoot) - Number(b === layout.installRoot) || b.length - a.length);
  for (const path of ordered) {
    try {
      if (path === layout.installRoot && result.failures.length) throw new Error("retained maintenance CLI because another cleanup failed");
      const safe = await safeParent(path); if (safe !== path) { if (!safe) { result.absent.push(path); continue; } throw new Error("parent changed during cleanup"); }
      const info = await io.stat(path); if (!info) { result.absent.push(path); continue; }
      await removeTree(path, info, (await io.stat(dirname(path)))?.dev ?? info.dev);
      result.removed.push(path);
    } catch (error) { errors(path, error); }
  }
  progress("[4/4] Refreshing service state and checking leftovers");
  if (systemd) {
    try {
      await run("systemctl", [...prefix, "daemon-reload"]);
      const reset = await executor.execute("systemctl", [...prefix, "reset-failed", "runmesh-runner.service"]);
      if (reset.exitCode !== 0) {
        const state = (await run("systemctl", [...prefix, "show", "runmesh-runner.service", "--property=LoadState", "--value"])).trim();
        if (state !== "not-found") throw new Error("cannot clear failed service state");
      }
    } catch (error) { errors("system service state", error); }
  }
  for (const path of paths) { try { if (await io.stat(path)) errors(path, new Error("still present after cleanup")); } catch (error) { errors(path, error); } }
  return { ...result, purged: result.failures.length === 0 };
}
