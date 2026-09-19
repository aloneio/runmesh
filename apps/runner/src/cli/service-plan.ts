import type { CliDependencies } from "./contracts.js";
import type { ExecutionMode } from "../service.js";
import { hostServiceManifestFilesystem } from "../service.js";
import { isManagedService } from "../service.js";
import { managedServiceManifestFromContent } from "../service.js";
import type { ParsedCommand } from "./contracts.js";
import type { ProbedServiceStatus } from "./contracts.js";
import { profileExecutionMode } from "../profile.js";
import { ProfileStore } from "../profile.js";
import { renderService } from "../service.js";
import { resolveTrustedWindowsTool } from "../windows-tools.js";
import { rewriteManagedServiceExecutionMode } from "../service.js";
import type { ServiceManagerAdapter } from "../service.js";
import type { ServiceManifest } from "../service.js";
import type { ServiceManifestFilesystem } from "../service.js";
import type { ServicePlatform } from "../service.js";
import { servicePrivilegeState } from "../service.js";
import { spawnSync } from "node:child_process";
import { trustedWindowsEnvironment } from "../windows-tools.js";
import { trustedWindowsRoot } from "../windows-tools.js";

/**
 * Destructive/lifecycle commands must not act on an unknown native service.
 * Production managers mark ambiguous native-query failures as unreliable;
 * injected legacy managers that omit the optional flag remain compatible.
 */
export async function probeServiceStatus(manager: ServiceManagerAdapter, manifest: ServiceManifest, action: string): Promise<ProbedServiceStatus | undefined> {
  if (manager.status === undefined) return undefined;
  let status: ProbedServiceStatus;
  try {
    status = await manager.status(manifest);
  } catch {
    throw new Error(`service status probe is unavailable; refusing to ${action} the Runner service`);
  }
  if (status.reliable === false) throw new Error(`service status probe is unavailable or unreliable; refusing to ${action} the Runner service`);
  if (status.active && servicePrivilegeState(manifest, status.identity, status.active) === "mismatch") {
    throw new Error(`active Runner service identity does not match the managed execution mode; refusing to ${action} the service`);
  }
  return status;
}

/** Restore only the exact manifest snapshot this transaction wrote. */
export async function restoreManifestSnapshot(filesystem: ServiceManifestFilesystem, manifest: ServiceManifest, previousContent: string | undefined, hadManagedManifest: boolean): Promise<void> {
  let current: string | undefined;
  try { current = await filesystem.read(manifest.path); } catch { return; }
  // A concurrent operator or package update owns the path once its bytes no
  // longer equal our candidate. Never overwrite or remove that newer state.
  if (current !== manifest.content) return;
  if (hadManagedManifest && previousContent !== undefined) await filesystem.write(manifest.path, previousContent).catch(() => undefined);
  else await filesystem.remove(manifest.path).catch(() => undefined);
}

export async function serviceManifestFor(parsed: ParsedCommand, store: ProfileStore, platform?: ServicePlatform, filesystem: ServiceManifestFilesystem | undefined = undefined): Promise<ServiceManifest> {
  const profile = await store.load();
  const requestedMode = parsed.values.executionMode;
  if (requestedMode !== undefined && requestedMode !== "dedicated_user" && requestedMode !== "privileged_host") throw new Error("--execution-mode must be dedicated_user or privileged_host");
  if (parsed.values.user === true && requestedMode === "privileged_host") throw new Error("user Runner services cannot use privileged_host; choose --execution-mode dedicated_user");
  const profileMode = profileExecutionMode(profile);
  const profileExecutionModeValue = profileMode;
  const needsExplicitMode = parsed.command === "install" || parsed.command === "migrate";
  if (parsed.values.user !== true && needsExplicitMode && profile !== undefined && profileMode === undefined && requestedMode === undefined) throw new Error("Runner profile is incomplete; enroll again or provide --execution-mode dedicated_user or --execution-mode privileged_host before system installation");
  let executionMode: ExecutionMode = parsed.values.user === true ? "dedicated_user" : requestedMode ?? profileExecutionModeValue ?? "dedicated_user";
  const requestedServiceMode = parsed.values.user === true ? "user" : "system";
  const renderOptions = {
    ...(platform === undefined ? {} : { platform }),
    mode: requestedServiceMode as "system" | "user",
    profilePath: store.filePath,
    executionMode,
    ...(typeof parsed.values.executablePath === "string" ? { executablePath: parsed.values.executablePath } : {}),
  };
  let manifest = renderService(renderOptions);
  const serviceFilesystem = filesystem ?? hostServiceManifestFilesystem;
  // Read the existing managed definition before rendering a replacement.  A
  // migration must retain operator-selected executable paths, arguments, and
  // service-manager settings; only the OS identity is allowed to change when
  // no explicit executable override was requested.
  const existing = await serviceFilesystem.read(manifest.path);
  if (existing === undefined || !isManagedService(existing)) return manifest;

  const existingMode = requestedServiceMode === "system"
    ? inferExecutionModeFromManifest(manifest.platform, existing)
    : "dedicated_user";
  if (requestedServiceMode === "system" && !needsExplicitMode && requestedMode === undefined
    && (parsed.command === "stop" || parsed.command === "restart" || parsed.command === "uninstall")) {
    // Lifecycle commands without an explicit mode should always address the
    // identity represented by the installed definition, even if a legacy
    // profile is stale or omits execution_mode.
    executionMode = existingMode;
    manifest = renderService({ ...renderOptions, executionMode });
  }

  if (parsed.values.executablePath === undefined) {
    const desired = renderService({ ...renderOptions, executionMode });
    if (desired.mode === "system" && desired.executionMode !== existingMode) {
      // Rewrite only User/Group, UserName, or the Windows principal.  The
      // existing command and all other service settings remain untouched.
      return rewriteManagedServiceExecutionMode(desired, existing, desired.executionMode);
    }
    return managedServiceManifestFromContent(desired, existing, desired.executionMode);
  }

  // An explicit executable path is an intentional service-definition update,
  // but a custom dedicated account remains an operator-owned setting.  Carry
  // that account through the re-render so changing the binary cannot silently
  // switch the service identity back to the default `runmesh` account.
  if (desiredServiceNeedsDedicatedIdentity(manifest)) {
    const identity = existingDedicatedIdentityOptions(manifest.platform, existing);
    manifest = renderService({ ...renderOptions, executionMode, ...identity });
  }
  return manifest;
}

export function assertSystemInstallationPrivilege(manifest: ServiceManifest, dependencies: CliDependencies): void {
  if (manifest.mode !== "system") return;
  const elevated = dependencies.isAdministrator ?? (() => {
    if (manifest.platform !== "win32") return process.getuid?.() === 0;
    // `net session` returns success only from an elevated Windows token.
    // Use the absolute inbox utility path.  Windows CreateProcess searches
    // the current directory before PATH even when PATH has been scrubbed;
    // resolving a bare `net.exe` here would let a same-directory binary run
    // in the administrator's context during install/uninstall.
    const systemRoot = trustedWindowsRoot();
    const executable = process.platform === "win32" ? resolveTrustedWindowsTool("net.exe", systemRoot) : "net";
    return spawnSync(executable, ["session"], {
      stdio: "ignore",
      windowsHide: true,
      ...(process.platform === "win32" ? { cwd: `${systemRoot}\\System32`, env: trustedWindowsEnvironment(systemRoot) } : {}),
    }).status === 0;
  });
  if (!elevated()) throw new Error("system Runner installation requires administrator/root privileges; rerun from an elevated administrator/root shell");
}

export function serviceCommandNames(action: "install" | "stop" | "restart" | "uninstall", manifest: ServiceManifest): readonly string[] {
  if (manifest.platform === "linux") {
    const prefix = manifest.mode === "user" ? "systemctl --user" : "systemctl";
    if (action === "install") return [`${prefix} daemon-reload`, `${prefix} enable --now runmesh-runner.service`, `${prefix} is-active --quiet runmesh-runner.service`];
    return [`${prefix} ${action === "uninstall" ? "disable --now" : action} runmesh-runner.service`];
  }
  return [];
}

/** Infer only the previously-installed mode when a legacy profile omitted it.
 * The manifest is accepted only after `isManagedService`, so this heuristic
 * is used solely to reload the exact managed definition during rollback; it
 * is never used to authorize a new installation or silently elevate one.
 */
export function inferExecutionModeFromManifest(platform: ServicePlatform, content: string): ExecutionMode {
  if (platform === "linux") {
    // A managed unit may have been rendered with an operator-supplied service
    // account.  Match the presence of a non-empty User= directive rather than
    // one literal account name; an otherwise valid dedicated unit must never
    // be mistaken for root during stop/restart/uninstall or migration
    // rollback.
    return /^\s*User\s*=\s*\S.*$/mu.test(content) ? "dedicated_user" : "privileged_host";
  }
  if (platform === "darwin") return content.includes("<key>UserName</key>") ? "dedicated_user" : "privileged_host";
  return /<UserId>\s*(?:SYSTEM|NT AUTHORITY\\SYSTEM)\s*<\/UserId>/iu.test(content) ? "privileged_host" : "dedicated_user";
}

function desiredServiceNeedsDedicatedIdentity(manifest: Pick<ServiceManifest, "mode" | "executionMode">): boolean {
  return manifest.mode === "system" && manifest.executionMode === "dedicated_user";
}

function existingDedicatedIdentityOptions(platform: ServicePlatform, content: string): { readonly serviceUser?: string; readonly serviceGroup?: string } {
  const safe = (value: string | undefined): value is string => value !== undefined && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(value);
  if (platform === "linux") {
    const user = /^\s*User\s*=\s*(\S+)\s*$/mu.exec(content)?.[1];
    const group = /^\s*Group\s*=\s*(\S+)\s*$/mu.exec(content)?.[1];
    return {
      ...(safe(user) ? { serviceUser: user } : {}),
      ...(safe(group) ? { serviceGroup: group } : {}),
    };
  }
  if (platform === "darwin") {
    const user = /<key>UserName<\/key><string>([^<]*)<\/string>/u.exec(content)?.[1];
    return safe(user) ? { serviceUser: user } : {};
  }
  return {};
}
