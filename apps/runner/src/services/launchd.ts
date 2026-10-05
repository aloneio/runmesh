import { MACOS_LABEL } from "./values.js";
import { nativeProbeReliable } from "./probes.js";
import { safeServiceReportedIdentity } from "./values.js";
import type { ServiceCommandExecutor } from "./contracts.js";
import type { ServiceManagerAdapter } from "./contracts.js";
import type { ServiceMode } from "./contracts.js";
import type { ServiceManifestFilesystem } from "./contracts.js";
import { isManagedService } from "./manifest.js";

export function createLaunchdManager(mode: ServiceMode, executor: ServiceCommandExecutor, execute: (file: string, args: readonly string[]) => Promise<void>, filesystem: Pick<ServiceManifestFilesystem, "read">): ServiceManagerAdapter {
  const platform = "darwin" as const;

    const domain = mode === "system" ? "system" : `gui/${process.getuid?.() ?? 0}`;
    const target = `${domain}/${MACOS_LABEL}`;
    const loaded = async (): Promise<boolean> => {
      const result = await executor.execute("launchctl", ["print", target]);
      if (!nativeProbeReliable(result, "query")) throw new Error("launchd service state could not be verified");
      return result.exitCode === 0;
    };
    const unload = async (): Promise<void> => {
      if (await loaded()) await execute("launchctl", ["bootout", target]);
    };
    return {
      platform, mode,
      install: async (manifest) => {
        // `bootstrap` rejects an already-loaded label.  Retry only this exact
        // Runmesh label after confirming it is already loaded and booting it
        // out.  A permission or malformed-plist failure must not be masked by
        // an unconditional bootout attempt.
        const bootstrapped = await executor.execute("launchctl", ["bootstrap", domain, manifest.path]);
        if (bootstrapped.exitCode !== 0) {
          const loaded = await executor.execute("launchctl", ["print", target]);
          if (loaded.exitCode !== 0) {
            const detail = bootstrapped.stderr === undefined || bootstrapped.stderr.trim() === "" ? "" : ` (${bootstrapped.stderr.trim().slice(0, 512)})`;
            throw new Error(`service command failed: launchctl bootstrap ${domain} ${manifest.path}${detail}`);
          }
          await execute("launchctl", ["bootout", target]);
          await execute("launchctl", ["bootstrap", domain, manifest.path]);
        }
        await execute("launchctl", ["enable", target]);
        await execute("launchctl", ["print", target]);
      },
      // SIGTERM alone lets KeepAlive immediately respawn the process. Unload
      // the native job while retaining its managed plist for a later restart.
      stop: unload,
      restart: async (manifest) => {
        if (await loaded()) await execute("launchctl", ["kickstart", "-k", target]);
        else {
          if (!isManagedService(await filesystem.read(manifest.path) ?? "")) throw new Error("managed launchd service manifest is missing");
          await execute("launchctl", ["bootstrap", domain, manifest.path]);
        }
      },
      uninstall: unload,
      status: async (manifest) => {
        const result = await executor.execute("launchctl", ["print", target]);
        const match = /(?:user|UserName)\s*=\s*([^\s]+)/u.exec(result.stdout ?? "");
        // A system LaunchDaemon that omits UserName is launched as root by
        // launchd. Report that native default explicitly so the status and
        // doctor layers can distinguish it from an unavailable identity.
        const state = /^\s*state\s*=\s*([^\s]+)\s*$/imu.exec(result.stdout ?? "")?.[1]?.toLowerCase();
        // launchctl can report a loaded job whose last process already
        // exited. Treat explicit non-running states as inactive; when older
        // launchctl output omits a state line, retain the successful print
        // result as the best available probe and let the identity check carry
        // the remaining safety signal.
        const active = result.exitCode === 0 && (state === undefined || state === "running" || state === "active");
        let identity = result.exitCode === 0
          ? safeServiceReportedIdentity(match?.[1]) ?? (manifest.mode === "system" && manifest.executionMode === "privileged_host" ? "root" : undefined)
          : undefined;
        // Some launchctl versions expose the configured UserName as a UID
        // (`user = 501`) rather than the account name. Resolve it when the
        // native lookup is available; servicePrivilegeState also recognizes a
        // non-zero UID as restricted for a dedicated macOS daemon.
        if (identity !== undefined && /^\d+$/u.test(identity)) {
          try {
            const resolved = await executor.execute("id", ["-un", identity]);
            const name = resolved.exitCode === 0 ? safeServiceReportedIdentity(resolved.stdout?.trim()) : undefined;
            if (name !== undefined) identity = name;
          } catch {
            // Identity resolution is an enhancement only; retain the numeric
            // UID so the privilege-state check can still classify the daemon.
          }
        }
        const reliable = nativeProbeReliable(result, "query");
        const registered = reliable ? result.exitCode === 0 : undefined;
        const installed = isManagedService(await filesystem.read(manifest.path) ?? "");
        return { installed, active, ...(registered === undefined ? {} : { registered }), reliable, ...(identity === undefined ? {} : { identity }), ...(result.stderr === undefined || result.stderr.trim() === "" ? {} : { detail: result.stderr.trim().slice(0, 512) }) };
      },
    };

}
