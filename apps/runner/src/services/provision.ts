import { currentServicePlatform } from "./values.js";
import { dedicatedServiceIdentity } from "./identity.js";
import type { ExecutionMode } from "./contracts.js";
import { hostServiceCommandExecutor } from "./command-executor.js";
import { isDefaultSystemProfile } from "./layout.js";
import type { ServiceCommandResult } from "./contracts.js";
import { serviceLayout } from "./layout.js";
import type { ServiceLayout } from "./contracts.js";
import type { ServicePlatform } from "./contracts.js";
import { serviceProfilePath } from "./layout.js";
import type { ServiceProvisioner } from "./contracts.js";
import type { ServiceProvisionerOptions } from "./contracts.js";

/**
 * Idempotent, platform-native setup for Runmesh-owned service state only.
 * It deliberately never changes ownership or permissions of caller Workspace roots.
 */
export function createServiceProvisioner(options: ServiceProvisionerOptions = {}): ServiceProvisioner {
  const platform = options.platform ?? currentServicePlatform();
  const executor = options.executor ?? hostServiceCommandExecutor;
  const execute = async (file: string, args: readonly string[]): Promise<ServiceCommandResult> => executor.execute(file, args);
  const required = async (file: string, args: readonly string[]): Promise<void> => {
    const result = await execute(file, args);
    if (result.exitCode !== 0) throw new Error(`service provisioning command failed: ${[file, ...args].join(" ")}${result.stderr === undefined || result.stderr.trim() === "" ? "" : ` (${result.stderr.trim().slice(0, 512)})`}`);
  };
  return {
    platform,
    provision: async (manifest, profilePath) => {
      if (manifest.mode !== "system") return { identity: "interactive", profileSecured: true };
      const layout = serviceLayout({ platform, mode: "system" });
      // A machine service must never be pointed at an operator-selected
      // profile path.  In particular, a SYSTEM/root service loading a file
      // from a user-controlled directory would turn that directory into a
      // durable privilege-escalation boundary.  Keep the canonical profile
      // location for both execution modes; user services can still use an
      // explicit profile through the foreground CLI.
      if (!isDefaultSystemProfile(layout, profilePath)) throw new Error(`system Runner profiles must be stored at ${serviceProfilePath(layout)}`);
      if (platform === "linux") {
        if (manifest.executionMode === "privileged_host") {
          // The privileged unit intentionally has no User=/Group= directive,
          // so all Runmesh-owned service state must remain root-only.  Do not
          // create or chown anything to the restricted `runmesh` account on
          // this path; doing so would both misreport identity and strand a
          // root service from its credential.
          await required("mkdir", ["-p", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
          await required("chown", ["root:root", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
          // A root service must not execute a package tree writable by a
          // non-root principal. Tighten every real package directory below
          // the Runmesh install root without following symlinks or changing
          // executable bits supplied by the verified package. The portable
          // installer creates `current` as a root-owned link to a version
          // directory inside this root; refusing to follow links here keeps a
          // malformed link from redirecting chown/chmod outside Runmesh.
          await securePosixInstallTree(required, layout.installRoot, "root:root", platform);
          await required("chmod", ["0755", layout.installRoot]);
          await required("chmod", ["0700", layout.configRoot, layout.stateRoot, layout.logRoot]);
          await securePosixTree(required, layout.configRoot, "root:root", "0700", "0600", platform);
          await securePosixTree(required, layout.stateRoot, "root:root", "0700", "0600", platform);
          await securePosixTree(required, layout.logRoot, "root:root", "0700", "0600", platform);
          if ((await execute("test", ["-f", profilePath])).exitCode === 0) {
            await required("chown", ["root:root", profilePath]);
            await required("chmod", ["0600", profilePath]);
            return { identity: "root", profileSecured: true };
          }
          return { identity: "root", profileSecured: false, detail: "profile is not present yet; enroll before installing the service" };
        }
        const identity = dedicatedServiceIdentity(manifest);
        if ((await execute("getent", ["group", identity.group])).exitCode !== 0) await required("groupadd", ["--system", identity.group]);
        if ((await execute("id", ["-u", identity.user])).exitCode !== 0) await required("useradd", ["--system", "--gid", identity.group, "--no-create-home", "--shell", "/usr/sbin/nologin", identity.user]);
        await required("mkdir", ["-p", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
        await required("chown", ["root:root", layout.installRoot]); await required("chmod", ["0755", layout.installRoot]);
        await securePosixInstallTree(required, layout.installRoot, "root:root", platform);
        await required("chown", [`root:${identity.group}`, layout.configRoot]); await required("chmod", ["0750", layout.configRoot]);
        await required("chown", [`${identity.user}:${identity.group}`, layout.stateRoot, layout.logRoot]); await required("chmod", ["0750", layout.stateRoot, layout.logRoot]);
        await securePosixTree(required, layout.configRoot, `root:${identity.group}`, "0750", "0640", platform);
        await securePosixTree(required, layout.stateRoot, `${identity.user}:${identity.group}`, "0750", "0640", platform);
        await securePosixTree(required, layout.logRoot, `${identity.user}:${identity.group}`, "0750", "0640", platform);
        if ((await execute("test", ["-f", profilePath])).exitCode === 0) {
          await required("chown", [`root:${identity.group}`, profilePath]); await required("chmod", ["0640", profilePath]);
          return { identity: identity.user, profileSecured: true };
        }
        return { identity: identity.user, profileSecured: false, detail: "profile is not present yet; enroll before installing the service" };
      }
      if (platform === "darwin") {
        if (manifest.executionMode === "privileged_host") {
          await required("mkdir", ["-p", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
          await required("chown", ["root:wheel", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
          await securePosixInstallTree(required, layout.installRoot, "root:wheel", platform);
          await required("chmod", ["0755", layout.installRoot]);
          await required("chmod", ["0700", layout.configRoot, layout.stateRoot, layout.logRoot]);
          await securePosixTree(required, layout.configRoot, "root:wheel", "0700", "0600", platform);
          await securePosixTree(required, layout.stateRoot, "root:wheel", "0700", "0600", platform);
          await securePosixTree(required, layout.logRoot, "root:wheel", "0700", "0600", platform);
          if ((await execute("test", ["-f", profilePath])).exitCode === 0) {
            await required("chown", ["root:wheel", profilePath]);
            await required("chmod", ["0600", profilePath]);
            return { identity: "root", profileSecured: true };
          }
          return { identity: "root", profileSecured: false, detail: "profile is not present yet; enroll before installing the service" };
        }
        const identity = dedicatedServiceIdentity(manifest);
        await provisionMacIdentity(execute, required, identity.user, identity.group);
        await required("mkdir", ["-p", layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot]);
        await required("chown", ["root:wheel", layout.installRoot]); await required("chmod", ["0755", layout.installRoot]);
        await securePosixInstallTree(required, layout.installRoot, "root:wheel", platform);
        await required("chown", [`root:${identity.group}`, layout.configRoot]); await required("chmod", ["0750", layout.configRoot]);
        await required("chown", [`${identity.user}:${identity.group}`, layout.stateRoot, layout.logRoot]); await required("chmod", ["0750", layout.stateRoot, layout.logRoot]);
        await securePosixTree(required, layout.configRoot, `root:${identity.group}`, "0750", "0640", platform);
        await securePosixTree(required, layout.stateRoot, `${identity.user}:${identity.group}`, "0750", "0640", platform);
        await securePosixTree(required, layout.logRoot, `${identity.user}:${identity.group}`, "0750", "0640", platform);
        if ((await execute("test", ["-f", profilePath])).exitCode === 0) {
          await required("chown", [`root:${identity.group}`, profilePath]); await required("chmod", ["0640", profilePath]);
          return { identity: identity.user, profileSecured: true };
        }
        return { identity: identity.user, profileSecured: false, detail: "profile is not present yet; enroll before installing the service" };
      }
      const script = windowsProvisionScript(layout, profilePath, manifest.executionMode);
      await required("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
      return { identity: manifest.executionMode === "privileged_host" ? "NT AUTHORITY\\SYSTEM" : "NT AUTHORITY\\LOCAL SERVICE", profileSecured: true };
    },
  };
}

/**
 * Tighten existing Runmesh-owned trees without following symlinks or crossing
 * filesystem mounts. Workspace roots are never passed to this helper.
 */
async function securePosixTree(required: (file: string, args: readonly string[]) => Promise<void>, root: string, owner: string, directoryMode: string, fileMode: string, platform: ServicePlatform = currentServicePlatform()): Promise<void> {
  // BSD -x is a global option, so it must precede every search path.
  const traversal = platform === "darwin" ? ["-P", "-x", root] : ["-P", root, "-xdev"];
  await required("find", [...traversal, "-type", "d", "-exec", "chown", owner, "{}", "+"]);
  await required("find", [...traversal, "-type", "f", "-exec", "chown", owner, "{}", "+"]);
  await required("find", [...traversal, "-type", "d", "-exec", "chmod", directoryMode, "{}", "+"]);
  await required("find", [...traversal, "-type", "f", "-exec", "chmod", fileMode, "{}", "+"]);
}

/** Remove group/other write access from the package tree while preserving
 * the executable/read bits selected by the verified package itself. */
async function securePosixInstallTree(required: (file: string, args: readonly string[]) => Promise<void>, root: string, owner: string, platform: ServicePlatform = currentServicePlatform()): Promise<void> {
  const traversal = platform === "darwin" ? ["-P", "-x", root] : ["-P", root, "-xdev"];
  await required("find", [...traversal, "-type", "d", "-exec", "chown", owner, "{}", "+"]);
  await required("find", [...traversal, "-type", "f", "-exec", "chown", owner, "{}", "+"]);
  await required("find", [...traversal, "-type", "d", "-exec", "chmod", "a-w", "{}", "+"]);
  await required("find", [...traversal, "-type", "f", "-exec", "chmod", "a-w", "{}", "+"]);
}

async function provisionMacIdentity(execute: (file: string, args: readonly string[]) => Promise<ServiceCommandResult>, required: (file: string, args: readonly string[]) => Promise<void>, user: string, group: string): Promise<void> {
  let groupId: string;
  if ((await execute("dscl", [".", "-read", `/Groups/${group}`])).exitCode !== 0) {
    groupId = nextDarwinId((await execute("dscl", [".", "-list", "/Groups", "PrimaryGroupID"])).stdout);
    await required("dscl", [".", "-create", `/Groups/${group}`]);
    await required("dscl", [".", "-create", `/Groups/${group}`, "PrimaryGroupID", groupId]);
  } else {
    groupId = parseDarwinId((await execute("dscl", [".", "-read", `/Groups/${group}`, "PrimaryGroupID"])).stdout) ?? "500";
  }
  if ((await execute("dscl", [".", "-read", `/Users/${user}`])).exitCode === 0) return;
  const userId = nextDarwinId((await execute("dscl", [".", "-list", "/Users", "UniqueID"])).stdout);
  await required("dscl", [".", "-create", `/Users/${user}`]);
  await required("dscl", [".", "-create", `/Users/${user}`, "UserShell", "/usr/bin/false"]);
  await required("dscl", [".", "-create", `/Users/${user}`, "RealName", "Runmesh Runner"]);
  await required("dscl", [".", "-create", `/Users/${user}`, "UniqueID", userId]);
  await required("dscl", [".", "-create", `/Users/${user}`, "PrimaryGroupID", groupId]);
  await required("dscl", [".", "-create", `/Users/${user}`, "NFSHomeDirectory", "/var/empty"]);
}

function nextDarwinId(value: string | undefined): string {
  const used = new Set((value ?? "").split(/\s+/).map((part) => Number(part)).filter((part) => Number.isSafeInteger(part) && part >= 500));
  for (let candidate = 500; candidate < 60_000; candidate += 1) if (!used.has(candidate)) return String(candidate);
  throw new Error("could not allocate a macOS service identity ID");
}

function parseDarwinId(value: string | undefined): string | undefined { const match = /\b(\d+)\b/u.exec(value ?? ""); return match?.[1]; }

function windowsProvisionScript(layout: ServiceLayout, profilePath: string, executionMode: ExecutionMode = "dedicated_user"): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const acl = (path: string, grants: readonly string[], recursive = true): string =>
    // Reset first so a pre-existing install cannot retain an explicit
    // Users/Everyone ACE that /grant:r alone would leave in place. Then turn
    // inheritance off and grant only the service identities we require.
    `& icacls ${quote(path)} /reset${recursive ? " /T" : ""} | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls reset failed' }; & icacls ${quote(path)} /inheritance:r /grant:r ${grants.map(quote).join(" ")}${recursive ? " /T" : ""} | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }; `;
  const roots = [layout.installRoot, layout.configRoot, layout.stateRoot, layout.logRoot].map(quote).join(", ");
  // SYSTEM is the only service principal needed by privileged_host.  Keep
  // Local Service out of that ACL so a restricted account cannot read or
  // tamper with the privileged Runner credential.  The dedicated path keeps
  // its narrower read/modify grants for backwards compatibility.
  const privileged = executionMode === "privileged_host";
  const readGrants = privileged
    ? ["BUILTIN\\Administrators:(OI)(CI)F", "NT AUTHORITY\\SYSTEM:(OI)(CI)F"]
    : ["BUILTIN\\Administrators:(OI)(CI)F", "NT AUTHORITY\\SYSTEM:(OI)(CI)F", "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)RX"];
  const modifyGrants = privileged
    ? ["BUILTIN\\Administrators:(OI)(CI)F", "NT AUTHORITY\\SYSTEM:(OI)(CI)F"]
    : ["BUILTIN\\Administrators:(OI)(CI)F", "NT AUTHORITY\\SYSTEM:(OI)(CI)F", "NT AUTHORITY\\LOCAL SERVICE:(OI)(CI)M"];
  const profileGrants = privileged
    ? ["BUILTIN\\Administrators:F", "NT AUTHORITY\\SYSTEM:F"]
    : ["BUILTIN\\Administrators:F", "NT AUTHORITY\\SYSTEM:F", "NT AUTHORITY\\LOCAL SERVICE:R"];
  // New-Item has no -LiteralPath parameter in Windows PowerShell. Use the
  // literal .NET API, which also keeps repeated provisioning idempotent.
  return `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version Latest; $paths = @(${roots}); foreach ($path in $paths) { [System.IO.Directory]::CreateDirectory($path) | Out-Null }; `
    + acl(layout.installRoot, readGrants)
    + acl(layout.configRoot, readGrants)
    + acl(layout.stateRoot, modifyGrants)
    + acl(layout.logRoot, modifyGrants)
    + `if (-not (Test-Path -LiteralPath ${quote(profilePath)} -PathType Leaf)) { throw 'runner profile is not present' }; `
    + acl(profilePath, profileGrants, false);
}
