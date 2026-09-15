import { resolveTrustedWindowsTool } from "../windows-tools.js";
import type { ServiceCommandExecutor } from "./contracts.js";
import { spawn } from "node:child_process";
import { trustedWindowsEnvironment } from "../windows-tools.js";
import { trustedWindowsRoot } from "../windows-tools.js";

/** Host-command executor used only outside tests; tests provide a recording executor. */
export const hostServiceCommandExecutor: ServiceCommandExecutor = {
  execute: (file, args) => new Promise((resolve, reject) => {
    // Service installation and lifecycle commands can run as root/SYSTEM.
    // Never resolve their bare command names through an operator-controlled
    // PATH (or inherit loader/runtime injection variables such as
    // LD_PRELOAD/PYTHONPATH).  The native service tools used below live in
    // these platform directories; a missing tool fails closed instead of
    // executing an arbitrary same-name binary from the caller's environment.
    const executable = process.platform === "win32" ? resolveTrustedWindowsTool(file) : file;
    const child = spawn(executable, [...args], {
      // Keep the cwd and environment in the inbox system directory as a
      // defense in depth. The executable itself has already been resolved to
      // an allow-listed absolute System32 path on Windows.
      cwd: trustedServiceWorkingDirectory(),
      env: trustedServiceEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = ""; let stderr = "";
    child.stdout?.on("data", (value: Buffer) => { stdout = `${stdout}${value.toString("utf8")}`.slice(0, 4_096); });
    child.stderr?.on("data", (value: Buffer) => { stderr = `${stderr}${value.toString("utf8")}`.slice(0, 4_096); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  }),
};

function trustedServiceEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    const systemRoot = trustedWindowsRoot();
    return trustedWindowsEnvironment(systemRoot);
  }
  return { PATH: process.platform === "darwin" ? "/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
}

function trustedServiceWorkingDirectory(): string {
  if (process.platform !== "win32") return "/";
  return `${trustedWindowsRoot()}\\System32`;
}
