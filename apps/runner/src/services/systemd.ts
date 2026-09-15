import { knownNonActiveUnit } from "./probes.js";
import { LINUX_SERVICE_NAME } from "./values.js";
import { nativeProbeReliable } from "./probes.js";
import { safeServiceReportedIdentity } from "./values.js";
import { SERVICE_STARTUP_STABILITY_DELAY_MS } from "./values.js";
import type { ServiceCommandExecutor } from "./contracts.js";
import type { ServiceManagerAdapter } from "./contracts.js";
import type { ServiceMode } from "./contracts.js";
import { systemdEnablementState } from "./probes.js";
import { systemdRegistrationState } from "./probes.js";

export function createSystemdManager(mode: ServiceMode, executor: ServiceCommandExecutor, execute: (file: string, args: readonly string[]) => Promise<void>): ServiceManagerAdapter {
  const platform = "linux" as const;

    const prefix = mode === "user" ? ["--user"] : [];
    return {
      platform, mode,
      install: async () => { await execute("systemctl", [...prefix, "daemon-reload"]); await execute("systemctl", [...prefix, "enable", "--now", LINUX_SERVICE_NAME]); await execute("systemctl", [...prefix, "is-active", "--quiet", LINUX_SERVICE_NAME]); },
      stop: async () => execute("systemctl", [...prefix, "stop", LINUX_SERVICE_NAME]),
      // Rollback of a previously disabled/masked/linked unit must not call
      // install(), because install enables and starts the unit.  Probe the
      // current enablement first and disable only an explicit enabled state;
      // leaving masked/linked/static states untouched preserves the operator's
      // registration rather than deleting or rewriting its symlink.
      disable: async () => {
        // The candidate manifest may already have been daemon-reloaded before
        // its lifecycle command failed. Reload the restored bytes while the
        // unit is still stopped, without changing its enablement state.
        await execute("systemctl", [...prefix, "daemon-reload"]);
        const current = await executor.execute("systemctl", [...prefix, "is-enabled", LINUX_SERVICE_NAME]);
        const state = systemdEnablementState(current);
        if (state === "enabled" || state === "enabled-runtime") {
          await execute("systemctl", [...prefix, "disable", LINUX_SERVICE_NAME]);
          return;
        }
        if (state === undefined) throw new Error("could not determine systemd unit enablement while restoring rollback state");
      },
      restart: async () => {
        await execute("systemctl", [...prefix, "restart", LINUX_SERVICE_NAME]);
        await new Promise((resolve) => setTimeout(resolve, SERVICE_STARTUP_STABILITY_DELAY_MS));
        await execute("systemctl", [...prefix, "is-active", "--quiet", LINUX_SERVICE_NAME]);
      },
      uninstall: async () => execute("systemctl", [...prefix, "disable", "--now", LINUX_SERVICE_NAME]),
      status: async (manifest) => {
        const installed = await executor.execute("systemctl", [...prefix, "is-enabled", LINUX_SERVICE_NAME]);
        const active = await executor.execute("systemctl", [...prefix, "is-active", "--quiet", LINUX_SERVICE_NAME]);
        const user = await executor.execute("systemctl", [...prefix, "show", LINUX_SERVICE_NAME, "--property=User", "--value"]);
        const installedReliable = nativeProbeReliable(installed, "enabled");
        const userReliable = nativeProbeReliable(user, "query");
        // `systemctl is-active --quiet` returns exit 4 with no output for a
        // missing unit on several systemd versions.  That code is otherwise
        // ambiguous (for example when a D-Bus query fails), so accept it as
        // a reliable inactive result only when the companion is-enabled/show
        // probes independently report a known absent/disabled unit.
        const activeReliable = nativeProbeReliable(active, "active", knownNonActiveUnit(installed) || knownNonActiveUnit(user));
        const registered = systemdRegistrationState(installed);
        const reliable = installedReliable && activeReliable && userReliable && registered !== undefined;
        const userProbeSucceeded = user.exitCode === 0;
        const reported = userProbeSucceeded ? safeServiceReportedIdentity((user.stdout ?? "").trim()) : undefined;
        // An empty, successful `systemctl show User` means the native default
        // (root) for a privileged system unit.  A failed identity probe is
        // different from an empty value and must remain unknown so install /
        // doctor cannot claim a privilege transition was verified.
        const identity = userProbeSucceeded && reported === undefined && manifest.mode === "system" && manifest.executionMode === "privileged_host" ? "root" : reported;
        return { installed: installed.exitCode === 0, active: active.exitCode === 0, ...(registered === undefined ? {} : { registered }), reliable, ...(identity === undefined ? {} : { identity }), ...(active.stderr === undefined || active.stderr.trim() === "" ? {} : { detail: active.stderr.trim().slice(0, 512) }) };
      },
    };

}
