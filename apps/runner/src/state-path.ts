import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { HostPlatform } from "./platform-types.js";

/**
 * Default local Runner state. Legacy RemoteCodingRunner locations are only
 * migration inputs and must not receive new Job or policy records.
 */
export function defaultRunnerStateDir(platform: HostPlatform = process.platform, home = homedir(), localAppData = process.env.LOCALAPPDATA): string {
  if (platform === "win32") return win32.join(localAppData ?? win32.join(home, "AppData", "Local"), "Runmesh", "state");
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Runmesh", "state");
  return posix.join(home, ".local", "state", "runmesh");
}
