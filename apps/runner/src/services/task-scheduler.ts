import { nativeProbeReliable } from "./probes.js";
import { safeServiceReportedIdentity } from "./values.js";
import type { ServiceCommandExecutor } from "./contracts.js";
import type { ServiceCommandResult } from "./contracts.js";
import type { ServiceManagerAdapter } from "./contracts.js";
import type { ServiceMode } from "./contracts.js";
import { WINDOWS_TASK_NAME } from "./values.js";

export function createTaskSchedulerManager(mode: ServiceMode, executor: ServiceCommandExecutor, execute: (file: string, args: readonly string[]) => Promise<void>): ServiceManagerAdapter {
  const platform = "win32" as const;
return {
    platform, mode,
    install: async (manifest) => { await execute("schtasks", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", manifest.path, "/F"]); await execute("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]); await execute("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME]); },
    stop: async () => execute("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]),
    restart: async () => { await execute("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]); await execute("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]); },
    uninstall: async () => {
      // `/Delete` does not terminate an already-running task. Best-effort
      // termination prevents an old Runner from retaining a credential after
      // uninstall; a not-running task is harmless and should not block delete.
      await executor.execute("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]);
      await execute("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
    },
      status: async () => {
        const installed = await executor.execute("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME]);
        // `schtasks /FO LIST /V` localizes both field names and state values.
        // Query the Task Scheduler COM API through PowerShell first and
        // serialize the numeric enum (Running = 4), which is locale-
        // independent and available even when the ScheduledTasks module is
        // missing. Keep a conservative text fallback for injected/very old
        // executors; a localized state that cannot be proven to be Running is
        // reported inactive rather than guessed active.
        let invariant: ServiceCommandResult | undefined;
        try {
          invariant = await executor.execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $task=$service.GetFolder('\\').GetTask('RunmeshRunner'); [pscustomobject]@{ state=[int]$task.State; identity=[string]$task.Definition.Principal.UserId } | ConvertTo-Json -Compress"]);
        } catch {
          // Injected/older executors may not expose PowerShell. Fall through
          // to the conservative schtasks text probe below.
          invariant = undefined;
        }
        let invariantState: { readonly state?: unknown; readonly identity?: unknown } | undefined;
        try {
          const parsed = JSON.parse((invariant?.stdout ?? "").trim()) as unknown;
          if (typeof parsed === "object" && parsed !== null) invariantState = parsed as { readonly state?: unknown; readonly identity?: unknown };
        } catch { /* use the text fallback below */ }
        if (invariant?.exitCode === 0 && invariantState !== undefined && (typeof invariantState.state === "number" || typeof invariantState.state === "string")) {
          const state = typeof invariantState.state === "number" ? invariantState.state : Number(invariantState.state);
          const identity = typeof invariantState.identity === "string" ? safeServiceReportedIdentity(invariantState.identity) ?? "" : "";
          const queryReliable = nativeProbeReliable(installed, "query") && nativeProbeReliable(invariant, "query");
          const registered = queryReliable ? true : undefined;
          return { installed: true, active: state === 4, ...(registered === undefined ? {} : { registered }), reliable: queryReliable, ...(identity === "" ? {} : { identity }), ...(invariant.stderr === undefined || invariant.stderr.trim() === "" ? {} : { detail: invariant.stderr.trim().slice(0, 512) }) };
        }
        const detail = await executor.execute("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"]);
        // Task Scheduler reports `Ready` for an installed task that is not
        // currently executing. Treat only `Running` as active; conflating the
        // two makes `doctor` report a stopped/crashed Runner as healthy.
        const active = detail.exitCode === 0 && /Status:\s*Running/iu.test(detail.stdout ?? "");
        const identity = safeServiceReportedIdentity(/Run As User:\s*(.+)/iu.exec(detail.stdout ?? "")?.[1]);
        const queryReliable = nativeProbeReliable(installed, "query") && nativeProbeReliable(detail, "query");
        const registered = queryReliable ? detail.exitCode === 0 || installed.exitCode === 0 : undefined;
        return { installed: installed.exitCode === 0, active, ...(registered === undefined ? {} : { registered }), reliable: queryReliable, ...(identity === undefined || identity === "" ? {} : { identity }), ...(detail.stderr === undefined || detail.stderr.trim() === "" ? {} : { detail: detail.stderr.trim().slice(0, 512) }) };
      },
  };
}
