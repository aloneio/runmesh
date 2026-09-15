import { DEDICATED_SERVICE_USER } from "./values.js";
import { privilegedIdentity } from "./values.js";
import { safeServiceIdentity } from "./values.js";
import type { ServiceAdapterOptions } from "./contracts.js";
import type { ServiceManifest } from "./contracts.js";
import type { ServicePlatform } from "./contracts.js";
import type { ServicePrivilegeState } from "./contracts.js";

export function dedicatedServiceIdentity(options: Pick<ServiceAdapterOptions, "serviceUser" | "serviceGroup"> = {}): { readonly user: string; readonly group: string } {
  const user = options.serviceUser ?? DEDICATED_SERVICE_USER;
  const group = options.serviceGroup ?? user;
  if (!safeServiceIdentity(user) || !safeServiceIdentity(group)) throw new Error("service user and group must be safe account names");
  return { user, group };
}

export function dedicatedIdentityFromContent(platform: ServicePlatform, body: string): { readonly serviceUser?: string; readonly serviceGroup?: string } {
  if (platform === "linux") {
    const lines = body.split(/\r?\n/u);
    const user = serviceIdentityFromLine(lines, "User");
    const group = serviceIdentityFromLine(lines, "Group") ?? user;
    if (user !== undefined && group !== undefined && safeServiceIdentity(user) && safeServiceIdentity(group)) return { serviceUser: user, serviceGroup: group };
    return {};
  }
  if (platform === "darwin") {
    const user = /<key>UserName<\/key><string>([^<]*)<\/string>/u.exec(body)?.[1];
    return user !== undefined && safeServiceIdentity(user) ? { serviceUser: user, serviceGroup: user } : {};
  }
  return {};
}

export function serviceIdentityFromLine(lines: readonly string[], key: "User" | "Group"): string | undefined {
  const line = lines.find((value) => new RegExp(`^\\s*${key}\\s*=`, "u").test(value));
  if (line === undefined) return undefined;
  const value = line.replace(new RegExp(`^\\s*${key}\\s*=\\s*`, "u"), "").trim();
  return value.length === 0 ? undefined : value;
}

/** The identity a manifest asks the native service manager to use. */
export function expectedServiceIdentity(manifest: Pick<ServiceManifest, "platform" | "mode" | "executionMode" | "serviceUser">): string | undefined {
  if (manifest.mode !== "system") return undefined;
  if (manifest.executionMode === "privileged_host") return privilegedIdentity(manifest.platform);
  return manifest.platform === "win32" ? "NT AUTHORITY\\LOCAL SERVICE" : manifest.serviceUser ?? "runmesh";
}

/**
 * Compare a service-manager identity with the manifest contract.  Status
 * probes are allowed to omit identity (for example an unloaded launchd
 * job); that is unknown rather than an implicit success.  The comparison is
 * intentionally conservative and never treats a privileged request as
 * satisfied by an arbitrary account name.
 */
export function servicePrivilegeState(manifest: Pick<ServiceManifest, "platform" | "mode" | "executionMode" | "serviceUser">, actualIdentity: string | undefined, active = true): ServicePrivilegeState {
  if (!active || actualIdentity === undefined || actualIdentity.trim() === "") return "unknown";
  const expected = expectedServiceIdentity(manifest);
  const normalize = (value: string): string => value.trim().replaceAll("/", "\\").toLowerCase();
  const actual = normalize(actualIdentity);
  // A user-level service must never be considered healthy when its manager
  // reports a host-wide identity.  We cannot require an exact username here
  // (the interactive account is platform-specific), but we can fail closed
  // for the identities that would constitute an unintended elevation.
  if (expected === undefined) {
    const hostPrivileged = manifest.platform === "win32"
      ? actual === "system" || actual === "nt authority\\system" || actual === "s-1-5-18"
      : actual === "root" || actual === "0" || actual === "uid=0";
    return hostPrivileged ? "mismatch" : "restricted";
  }
  // launchctl can expose a numeric UID.  Only a successful `id -un` lookup
  // proves which configured account owns that UID; accepting every non-zero
  // number would turn an arbitrary restricted account into a healthy
  // dedicated service. UID 0 is an explicit elevation mismatch, while an
  // unresolved non-zero UID remains unknown and must be re-probed.
  if (manifest.platform === "darwin" && manifest.executionMode === "dedicated_user" && /^\d+$/u.test(actual)) {
    return actual === "0" ? "mismatch" : "unknown";
  }
  const wanted = normalize(expected);
  const matches = actual === wanted
    || (manifest.platform === "win32" && manifest.executionMode === "privileged_host" && (actual === "system" || actual === "nt authority\\system" || actual === "s-1-5-18"))
    || (manifest.platform !== "win32" && manifest.executionMode === "privileged_host" && (actual === "root" || actual === "0" || actual === "uid=0"))
    || (manifest.platform !== "win32" && manifest.executionMode === "dedicated_user" && actual === (manifest.serviceUser ?? "runmesh").toLowerCase())
    || (manifest.platform === "win32" && manifest.executionMode === "dedicated_user" && (actual === "local service" || actual === "nt authority\\local service" || actual === "s-1-5-19"));
  if (!matches) return "mismatch";
  return manifest.executionMode === "privileged_host" ? "privileged" : "restricted";
}
