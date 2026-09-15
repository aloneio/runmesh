import { dirname } from "node:path";
import type { InstallServiceManifestOptions } from "./contracts.js";
import { isErrno } from "./values.js";
import { isManagedService } from "./manifest.js";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { rename } from "node:fs/promises";
import { rm } from "node:fs/promises";
import type { ServiceManifest } from "./contracts.js";
import type { ServiceManifestFilesystem } from "./contracts.js";
import { writeFile } from "node:fs/promises";

export const hostServiceManifestFilesystem: ServiceManifestFilesystem = {
  read: async (path) => readFile(path, "utf8").catch((error: unknown) => isErrno(error, "ENOENT") ? undefined : Promise.reject(error)),
  write: async (path, content) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Use a unique, exclusive temporary file. A PID-derived name can collide
    // with a concurrent install (or be pre-created as a symlink), causing
    // cross-write corruption or redirecting privileged manifest content.
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      // A failed write/rename must not leave a privileged manifest snapshot or
      // a reusable temp pathname behind.
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  },
  remove: async (path) => { await rm(path); },
};

/**
 * Install a managed manifest and report whether its bytes changed.  The
 * change bit is deliberately calculated before the atomic write so callers
 * can decide whether a running service needs a restart.  Returning a boolean
 * is backwards compatible with callers that only await the operation.
 */
export async function installServiceManifest(manifest: ServiceManifest, filesystem: ServiceManifestFilesystem = hostServiceManifestFilesystem, options: InstallServiceManifestOptions = {}): Promise<boolean> {
  if (manifest.mode === "system" && manifest.executionMode === "privileged_host" && options.confirmPrivilegedHost !== true) {
    throw new Error("privileged_host service installation requires --confirm-privileged-host");
  }
  const existing = await filesystem.read(manifest.path);
  if (existing !== undefined && !isManagedService(existing)) throw new Error(`refusing to overwrite unmanaged service manifest: ${manifest.path}`);
  const changed = existing !== manifest.content;
  if (changed) await filesystem.write(manifest.path, manifest.content);
  return changed;
}

export async function removeServiceManifest(manifest: ServiceManifest, filesystem: ServiceManifestFilesystem = hostServiceManifestFilesystem): Promise<boolean> {
  const existing = await filesystem.read(manifest.path);
  if (existing === undefined) return false;
  if (!isManagedService(existing)) throw new Error(`refusing to remove unmanaged service manifest: ${manifest.path}`);
  await filesystem.remove(manifest.path);
  return true;
}

export async function assertManagedServiceManifest(manifest: ServiceManifest, filesystem: ServiceManifestFilesystem = hostServiceManifestFilesystem): Promise<boolean> {
  const existing = await filesystem.read(manifest.path);
  if (existing === undefined) return false;
  if (!isManagedService(existing)) throw new Error(`refusing to manage unmanaged service manifest: ${manifest.path}`);
  return true;
}
