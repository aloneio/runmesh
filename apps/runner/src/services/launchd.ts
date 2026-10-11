import { MACOS_LABEL } from "./values.js";
import { SERVICE_STARTUP_STABILITY_DELAY_MS } from "./values.js";
import { nativeProbeReliable } from "./probes.js";
import { safeServiceReportedIdentity } from "./values.js";
import type { ServiceCommandExecutor } from "./contracts.js";
import type { ServiceManagerAdapter } from "./contracts.js";
import type { ServiceMode } from "./contracts.js";
import type { ServiceManifestFilesystem } from "./contracts.js";
import type { ServiceManagerOptions } from "./contracts.js";
import { isManagedService } from "./manifest.js";
import { createLaunchdStopRecovery } from "./launchd-stop.js";

export { launchdProcessExited, waitForLaunchdExit } from "./launchd-stop.js";

function launchdState(output: string): string | undefined {
  return /^[\t ]*state[\t ]*=[\t ]*([^\r\n]*)/imu.exec(output)?.[1]?.trim().toLowerCase();
}

export function createLaunchdManager(mode: ServiceMode, executor: ServiceCommandExecutor, execute: (file: string, args: readonly string[]) => Promise<void>, filesystem: Pick<ServiceManifestFilesystem, "read">, options: Pick<ServiceManagerOptions, "stopRecoveryFilesystem" | "now" | "delay"> = {}): ServiceManagerAdapter {
  const platform = "darwin" as const;

    const domain = mode === "system" ? "system" : `gui/${process.getuid?.() ?? 0}`;
    const target = `${domain}/${MACOS_LABEL}`;
    const loaded = async (): Promise<boolean> => {
      const result = await executor.execute("launchctl", ["print", target]);
      if (!nativeProbeReliable(result, "query")) throw new Error("launchd service state could not be verified");
      return result.exitCode === 0;
    };
    const recovery = (manifestPath: string) => createLaunchdStopRecovery({ executor, target, mode, manifestPath,
      ...(options.stopRecoveryFilesystem === undefined ? {} : { filesystem: options.stopRecoveryFilesystem }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.delay === undefined ? {} : { delay: options.delay }),
    });
    const waitForStartup = async (): Promise<void> => {
      const now = options.now ?? (() => performance.now());
      const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const deadline = now() + 5_000;
      let runningSince: number | undefined, runningPid: number | undefined;
      while (true) {
        const result = await executor.execute("launchctl", ["print", target]);
        if (!nativeProbeReliable(result, "query")) throw new Error("launchd service state could not be verified");
        const output = result.stdout ?? "";
        const state = launchdState(output);
        const pid = Number(/^[\t ]*pid[\t ]*=[\t ]*(\d+)[\t ]*$/imu.exec(output)?.[1]);
        const observedAt = now();
        // A loaded job can still be awaiting spawn or repeatedly crashing.
        // Require one running process to survive the whole stability window.
        if (result.exitCode === 0 && (state === "running" || state === "active") && Number.isSafeInteger(pid) && pid > 0) {
          if (runningPid !== pid) { runningPid = pid; runningSince = observedAt; }
          if (runningSince !== undefined && observedAt - runningSince >= SERVICE_STARTUP_STABILITY_DELAY_MS && observedAt <= deadline) return;
        } else { runningSince = undefined; runningPid = undefined; }
        if (observedAt >= deadline) throw new Error("launchd service did not become active before the startup deadline");
        await delay(100);
      }
    };
    return {
      platform, mode,
      install: async (manifest) => {
        await recovery(manifest.path).recover();
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
          await recovery(manifest.path).stop();
          await execute("launchctl", ["bootstrap", domain, manifest.path]);
        }
        await execute("launchctl", ["enable", target]);
        await waitForStartup();
      },
      // SIGTERM alone lets KeepAlive immediately respawn the process. Unload
      // the native job while retaining its managed plist for a later restart.
      stop: async (manifest) => recovery(manifest.path).stop(),
      restart: async (manifest) => {
        await recovery(manifest.path).recover();
        if (await loaded()) await execute("launchctl", ["kickstart", "-k", target]);
        else {
          if (!isManagedService(await filesystem.read(manifest.path) ?? "")) throw new Error("managed launchd service manifest is missing");
          await execute("launchctl", ["bootstrap", domain, manifest.path]);
        }
        await waitForStartup();
      },
      uninstall: async (manifest) => recovery(manifest.path).stop(),
      status: async (manifest) => {
        const result = await executor.execute("launchctl", ["print", target]);
        const match = /(?:user|UserName)\s*=\s*([^\s]+)/u.exec(result.stdout ?? "");
        // A system LaunchDaemon that omits UserName is launched as root by
        // launchd. Report that native default explicitly so the status and
        // doctor layers can distinguish it from an unavailable identity.
        const state = launchdState(result.stdout ?? "");
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
