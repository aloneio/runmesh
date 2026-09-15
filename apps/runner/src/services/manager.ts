import { createLaunchdManager } from "./launchd.js";
import { createSystemdManager } from "./systemd.js";
import { createTaskSchedulerManager } from "./task-scheduler.js";
import { currentServicePlatform } from "./values.js";
import { hostServiceCommandExecutor } from "./command-executor.js";
import { LINUX_SERVICE_NAME } from "./values.js";
import { MACOS_LABEL } from "./values.js";
import type { ServiceManagerAdapter } from "./contracts.js";
import type { ServiceManagerOptions } from "./contracts.js";
import type { ServiceMode } from "./contracts.js";
import type { ServicePlatform } from "./contracts.js";
import { WINDOWS_TASK_NAME } from "./values.js";

/** Explicit, injectable machine service adapters. No adapter falls back to a user service. */
export function createServiceManager(options: ServiceManagerOptions = {}): ServiceManagerAdapter {
  const platform = options.platform ?? currentServicePlatform();
  const mode = options.mode ?? "system";
  const executor = options.executor ?? hostServiceCommandExecutor;
  const execute = async (file: string, args: readonly string[]): Promise<void> => {
    const result = await executor.execute(file, args);
    if (result.exitCode !== 0) throw new Error(`service command failed: ${[file, ...args].join(" ")}${result.stderr === undefined || result.stderr.length === 0 ? "" : ` (${result.stderr.trim().slice(0, 512)})`}`);
  };
  if (platform === "linux") return createSystemdManager(mode, executor, execute);
  if (platform === "darwin") return createLaunchdManager(mode, executor, execute);
  return createTaskSchedulerManager(mode, executor, execute);
}

export function serviceCommands(action: "install" | "start" | "stop" | "restart" | "uninstall", platform: ServicePlatform = currentServicePlatform(), mode: ServiceMode = "system"): readonly string[] {
  if (platform === "linux") {
    const prefix = mode === "user" ? "systemctl --user" : "systemctl";
    if (action === "install") return [`${prefix} daemon-reload`, `${prefix} enable --now ${LINUX_SERVICE_NAME}`, `${prefix} is-active --quiet ${LINUX_SERVICE_NAME}`];
    return [`${prefix} ${action === "uninstall" ? "disable --now" : action} ${LINUX_SERVICE_NAME}`];
  }
  if (platform === "darwin") {
    const domain = mode === "system" ? "system" : "gui/$(id -u)";
    if (action === "install") return [`launchctl bootstrap ${domain} <manifest>`, `launchctl enable ${domain}/${MACOS_LABEL}`, `launchctl print ${domain}/${MACOS_LABEL}`];
    return [`launchctl ${action === "uninstall" ? "bootout" : action === "restart" ? "kickstart -k" : "kill SIGTERM"} ${domain}/${MACOS_LABEL}`];
  }
  if (action === "install") return [`schtasks /Create /TN ${WINDOWS_TASK_NAME} /XML <manifest> /F`, `schtasks /Run /TN ${WINDOWS_TASK_NAME}`, `schtasks /Query /TN ${WINDOWS_TASK_NAME}`];
  return [`schtasks /${action === "start" ? "Run" : action === "stop" ? "End" : action === "uninstall" ? "Delete" : "Run"} /TN ${WINDOWS_TASK_NAME}`];
}
