import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { renderPosixInstaller, renderPowerShellInstaller } from "../apps/worker/dist/installer.js";
import { resolveTrustedWindowsTool, trustedWindowsRoot } from "../apps/runner/dist/windows-tools.js";

// Parse generated scripts only. Never execute installation, enrollment or service changes.
const directory = await mkdtemp(join(tmpdir(), "runmesh-installer-syntax-"));
try {
  if (process.platform === "win32") {
    const filename = join(directory, "installer.ps1");
    await writeFile(filename, renderPowerShellInstaller("https://syntax.example"));
    const command = "$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile($env:RUNMESH_SYNTAX_FILE, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }";
    execFileSync(resolveTrustedWindowsTool("powershell", trustedWindowsRoot()), ["-NoProfile", "-NonInteractive", "-Command", command], { env: { ...process.env, RUNMESH_SYNTAX_FILE: filename }, stdio: "inherit", timeout: 30_000 });
  } else {
    const filename = join(directory, "installer.sh");
    await writeFile(filename, renderPosixInstaller("https://syntax.example"));
    execFileSync("/bin/sh", ["-n", filename], { stdio: "inherit", timeout: 10_000 });
  }
  console.log(`installer syntax verified on ${process.platform}; no installer was executed`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
