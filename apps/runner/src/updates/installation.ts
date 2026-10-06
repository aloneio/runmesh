import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isExactUpdateVersion, UpdateFailure, type InstalledRelease, type InstallationPointerPort } from "./contracts.js";

const missing = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const samePath = (left: string, right: string): boolean => process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

/** Only the stable link changes. Version trees, credentials, runtime state and
 * native service definitions remain intact, including during recovery. */
export class ManagedInstallationPointer implements InstallationPointerPort {
  public constructor(private readonly installRoot: string, private readonly windows = process.platform === "win32") {}

  private async roots(): Promise<string> {
    const root = resolve(this.installRoot); const versions = join(root, "versions");
    for (const directory of [root, versions]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)
        || (process.platform !== "win32" && ((info.mode & 0o022) !== 0 || info.uid !== process.getuid?.()))) throw new UpdateFailure("invalid_installation");
    }
    return versions;
  }

  private async versionAt(directory: string): Promise<InstalledRelease> {
    const versions = await this.roots(); const target = resolve(directory);
    if (!samePath(dirname(target), versions) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u.test(basename(target))) throw new UpdateFailure("invalid_installation");
    const packageParts = this.windows ? ["node_modules", "@aloneio", "runmesh-runner"] : ["lib", "node_modules", "@aloneio", "runmesh-runner"];
    let checked = target;
    for (const component of ["", ...packageParts]) {
      if (component) checked = join(checked, component);
      const info = await lstat(checked);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(checked), checked)
        || (process.platform !== "win32" && ((info.mode & 0o022) !== 0 || info.uid !== process.getuid?.()))) throw new UpdateFailure("invalid_installation");
    }
    const path = join(checked, "package.json"); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 64 * 1024
      || (process.platform !== "win32" && ((info.mode & 0o022) !== 0 || info.uid !== process.getuid?.()))) throw new UpdateFailure("invalid_installation");
    const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    let value: unknown;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new UpdateFailure("invalid_installation");
      const bytes = Buffer.alloc(info.size + 1); let offset = 0;
      while (offset < bytes.length) { const part = await handle.read(bytes, offset, bytes.length - offset, null); if (part.bytesRead === 0) break; offset += part.bytesRead; }
      const after = await handle.stat(); const current = await lstat(path);
      if (offset !== info.size || after.size !== info.size || after.mtimeMs !== opened.mtimeMs || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw new UpdateFailure("invalid_installation");
      value = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    } finally { await handle.close(); }
    if (typeof value !== "object" || value === null || !("name" in value) || value.name !== "@aloneio/runmesh-runner" || !("version" in value) || typeof value.version !== "string" || !isExactUpdateVersion(value.version)) throw new UpdateFailure("invalid_installation");
    return { version: value.version, directory: target };
  }

  private async checked(release: InstalledRelease): Promise<InstalledRelease> {
    const observed = await this.versionAt(release.directory);
    if (observed.version !== release.version) throw new UpdateFailure("invalid_installation");
    return observed;
  }

  private async linked(path: string): Promise<InstalledRelease | undefined> {
    let info;
    try { info = await lstat(path); } catch (error) { if (missing(error)) return undefined; throw error; }
    if (!info.isSymbolicLink()) throw new UpdateFailure("invalid_installation");
    return this.versionAt(await realpath(path));
  }

  private async link(path: string, target: InstalledRelease): Promise<void> {
    const existing = await this.linked(path);
    if (existing !== undefined) { if (!samePath(existing.directory, target.directory)) throw new UpdateFailure("invalid_installation"); return; }
    await symlink(target.directory, path, this.windows ? "junction" : "dir");
  }

  private paths(operationId: string) {
    const id = createHash("sha256").update(operationId).digest("hex").slice(0, 24);
    return { current: join(this.installRoot, "current"), next: join(this.installRoot, `.manager-current-${id}.next`), previous: join(this.installRoot, `.manager-current-${id}.previous`), failed: join(this.installRoot, `.manager-current-${id}.failed`), restore: join(this.installRoot, `.manager-current-${id}.restore`) };
  }

  private async syncRoot(): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(this.installRoot, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  public async inspect(): Promise<InstalledRelease> {
    try { const current = await this.linked(join(this.installRoot, "current")); if (current === undefined) throw new UpdateFailure("invalid_installation"); return current; }
    catch (error) { throw error instanceof UpdateFailure ? error : new UpdateFailure("invalid_installation"); }
  }

  private async recoveryState(previous: InstalledRelease, next: InstalledRelease | undefined, operationId: string) {
    await this.checked(previous); const paths = this.paths(operationId);
    const current = await this.linked(paths.current);
    if (current !== undefined && samePath(current.directory, previous.directory)) return { paths, current };
    if (current !== undefined) {
      if (next === undefined || !samePath(current.directory, next.directory)) throw new UpdateFailure("invalid_installation");
      await this.checked(next);
    }
    if (this.windows) {
      const backup = await this.linked(paths.previous);
      if (backup === undefined || !samePath(backup.directory, previous.directory)) throw new UpdateFailure("invalid_installation");
      if (current !== undefined && await this.linked(paths.failed) !== undefined) throw new UpdateFailure("invalid_installation");
    } else {
      if (current === undefined) throw new UpdateFailure("invalid_installation");
      const restore = await this.linked(paths.restore);
      if (restore !== undefined && !samePath(restore.directory, previous.directory)) throw new UpdateFailure("invalid_installation");
    }
    return { paths, current };
  }

  /** Check ownership before stopping a service that may belong to a replacement installation. */
  public async assertRecoverable(previous: InstalledRelease, next: InstalledRelease | undefined, operationId: string): Promise<void> {
    try { await this.recoveryState(previous, next, operationId); }
    catch (error) { throw error instanceof UpdateFailure ? error : new UpdateFailure("invalid_installation"); }
  }

  public async switch(previous: InstalledRelease, next: InstalledRelease, operationId: string): Promise<void> {
    await this.checked(previous); await this.checked(next);
    const paths = this.paths(operationId); const current = await this.linked(paths.current);
    if (current !== undefined && samePath(current.directory, next.directory)) return;
    if (current === undefined || !samePath(current.directory, previous.directory)) throw new UpdateFailure("invalid_installation");
    await this.link(paths.next, next);
    const rechecked = await this.linked(paths.current);
    if (rechecked === undefined || !samePath(rechecked.directory, previous.directory)) throw new UpdateFailure("invalid_installation");
    if (this.windows) {
      // Windows cannot atomically replace a directory junction. The durable
      // coordinator phase precedes both renames; restore handles the gap.
      if (await this.linked(paths.previous) !== undefined) throw new UpdateFailure("invalid_installation");
      await rename(paths.current, paths.previous);
    }
    await rename(paths.next, paths.current);
    await this.syncRoot();
  }

  public async restore(previous: InstalledRelease, next: InstalledRelease | undefined, operationId: string): Promise<void> {
    // Repeat the read-only preflight at mutation time; an earlier caller's
    // check must not authorize restoring a pointer that has since changed.
    const { paths, current } = await this.recoveryState(previous, next, operationId);
    if (current !== undefined && samePath(current.directory, previous.directory)) return;
    if (this.windows) {
      if (current !== undefined) await rename(paths.current, paths.failed);
      await rename(paths.previous, paths.current);
    } else {
      await this.link(paths.restore, previous); await rename(paths.restore, paths.current);
    }
    await this.syncRoot();
  }
}
