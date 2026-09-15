import type { RunnerExecutionMode } from "../registry.js";
import { shellQuote, powershellQuote } from "../installer.js";
import { adminStyles } from "../admin-styles.js";
import { escapeHtml } from "./format.js";
import { controlHeader } from "./layout.js";
import { adminScript } from "./client-script.js";
import { executionModeFormFields, windowFields } from "./runner-fields.js";

/** Presentation only. The HTTP adapter must validate origin, enrollment state
 * and privilege acknowledgement before constructing this view model. */
export interface EnrollmentView {
  readonly publicBase: string; readonly runnerId: string; readonly code: string;
  readonly csrf: string; readonly reEnroll: boolean; readonly bootstrap: boolean;
  readonly executionMode: RunnerExecutionMode; readonly maxValidityDays: number;
  readonly enrollment: { readonly expires_at_ms: number } | undefined;
}
export function enrollmentDocument({ publicBase, runnerId, code, csrf, reEnroll, bootstrap, executionMode, maxValidityDays, enrollment }: EnrollmentView): string {
  const installerQuery = executionMode === "dedicated_user" ? "?execution_mode=dedicated_user" : "";
  const shellInstallerUrl = shellQuote(new URL(`/runner/install.sh${installerQuery}`, publicBase).toString());
  const powerShellInstallerUrl = powershellQuote(new URL(`/runner/install.ps1${installerQuery}`, publicBase).toString());
  const shellCode = shellQuote(code);
  const powerShellCode = powershellQuote(code);
  const shellCommand = `curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 0 --max-time 60 --max-filesize 262144 ${shellInstallerUrl} | sudo sh -s -- ${shellCode}`;
  // Invoke a clean PowerShell child so the copied command works from either
  // an elevated PowerShell prompt or cmd.exe, regardless of the operator's
  // profile aliases/functions or execution-policy setting. The installer
  // receives the single-use code as its sole argument for one-copy setup.
  // Treat the complete command as credential material; manual input is optional.
  const powerShellCommand = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 60 -ErrorAction Stop -Uri ${powerShellInstallerUrl}).Content)) ${powerShellCode}"`;
  const server = new URL("/runner/enroll", publicBase).toString();
  const shellServer = shellQuote(server);
  const powershellServer = powershellQuote(server);
  const modeFlags = executionMode === "privileged_host" ? "--execution-mode privileged_host --confirm-privileged-host" : "--execution-mode dedicated_user";
  const modeLabel = executionMode === "privileged_host" ? "整机控制 / 高权限模式（privileged_host）" : "受限服务账户模式（dedicated_user）";
  const privilegedWarning = "Runner 将以 root、SYSTEM 或平台等效最高权限运行。Shell 命令可以访问该服务身份可访问的文件、进程、网络、环境变量、凭据和系统服务。仅应安装在受信任的专用机器、虚拟机或容器中。";
  const reEnrollFlag = reEnroll ? " --re-enroll" : "";
  const manualCommands = {
    linux: `set -euo pipefail
RUNNER=/opt/runmesh/current/bin/runmesh # replace with the verified absolute path if different
test -x "$RUNNER"
printf '%s' 'One-time enrollment code: ' >&2
read -r -s RUNMESH_ENROLLMENT_CODE
printf '\\n' >&2
printf '%s\\n' "$RUNMESH_ENROLLMENT_CODE" | sudo "$RUNNER" enroll --server ${shellServer} --code-stdin${reEnrollFlag} ${modeFlags}
unset RUNMESH_ENROLLMENT_CODE
sudo "$RUNNER" install ${modeFlags} --executable-path "$RUNNER"
sudo "$RUNNER" doctor --json`,
    macos: `set -euo pipefail
RUNNER=/opt/runmesh/current/bin/runmesh # replace with the verified absolute path if different
test -x "$RUNNER"
printf '%s' 'One-time enrollment code: ' >&2
read -r -s RUNMESH_ENROLLMENT_CODE
printf '\\n' >&2
printf '%s\\n' "$RUNMESH_ENROLLMENT_CODE" | sudo "$RUNNER" enroll --server ${shellServer} --code-stdin${reEnrollFlag} ${modeFlags}
unset RUNMESH_ENROLLMENT_CODE
sudo "$RUNNER" install ${modeFlags} --executable-path "$RUNNER"
sudo "$RUNNER" doctor --json`,
    windows: `# Run this in an elevated PowerShell session
$ErrorActionPreference = 'Stop'
$RunnerPath = 'C:\\Program Files\\Runmesh\\current\\runmesh.cmd' # replace with the verified absolute shim path if different
if (-not (Test-Path -LiteralPath $RunnerPath -PathType Leaf)) { throw 'Set RunnerPath to the verified runmesh.cmd path.' }
$SecureCode = Read-Host 'One-time enrollment code' -AsSecureString
$CodePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureCode)
try { $EnrollmentCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($CodePointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($CodePointer); $SecureCode.Dispose() }
try {
  $EnrollmentCode | & $RunnerPath enroll --server ${powershellServer} --code-stdin${reEnrollFlag} ${modeFlags}
  if ($LASTEXITCODE -ne 0) { throw 'Runner enrollment failed.' }
} finally {
  Remove-Variable EnrollmentCode -ErrorAction SilentlyContinue
}
& $RunnerPath install ${modeFlags} --executable-path $RunnerPath
if ($LASTEXITCODE -ne 0) { throw 'Runner service installation failed.' }
& $RunnerPath doctor --json
if ($LASTEXITCODE -ne 0) { throw 'Runner doctor check failed.' }`,
  };
  // Both reviewed execution modes use one command after release verification.
  const commands = bootstrap ? { linux: shellCommand, macos: shellCommand, windows: powerShellCommand } : manualCommands;
  const tabs = Object.entries(commands).map(([platform], index) => `<button role="tab" id="tab-${platform}" aria-controls="panel-${platform}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}" data-tab="${platform}">${platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux"}</button>`).join("");
  const panels = Object.entries(commands).map(([platform, value], index) => `<section role="tabpanel" id="panel-${platform}" aria-labelledby="tab-${platform}" ${index === 0 ? "" : "hidden"} class="${index === 0 ? "is-active" : ""}" data-panel="${platform}"><pre><code>${escapeHtml(value)}</code></pre><button type="button" class="button secondary" data-copy="" data-copy-source="command">Copy ${commands === manualCommands ? "enrollment and install" : "installer"} command</button></section>`).join("");
  const title = commands === manualCommands ? "Manual portable-artifact enrollment" : "One-command Runner setup";
  const instruction = commands === manualCommands
    ? `Manual Runner enrollment and install uses a verified portable artifact. Install the artifact first, then run the single-line command below. It will ask for this code locally; paste it and press Enter. Selected execution mode: ${modeLabel}. The default is dedicated_user; privileged_host is an advanced, explicitly confirmed option. The install step runs only after enrollment succeeds.`
    : `The installer verifies the fixed signed Runner artifact, downloads and verifies a private Node.js runtime for the host architecture, registers the Runner as a background service, and starts it after enrollment. The copied command includes the one-time enrollment code; no second code entry is needed. Treat the command as a secret. Selected execution mode: ${modeLabel}. The default is dedicated_user; privileged_host is an advanced, explicitly confirmed option.`;
  const warningBlock = executionMode === "privileged_host" ? `<p class="warning privileged-host-warning">${escapeHtml(privilegedWarning)} You must keep the one-time confirmation in the local install command.</p>` : `<p class="notice">Selected restricted service account mode: dedicated_user. The installer preserves this selection.</p>`;
  const enrollmentSummary = enrollment === undefined ? "The one-time enrollment code expires after 30 minutes." : `This code is valid until ${new Date(enrollment.expires_at_ms).toISOString()} and can be used once.`;
  const uninstallShell = `curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --max-redirs 0 --max-time 60 --max-filesize 262144 ${shellQuote(new URL("/runner/uninstall.sh", publicBase).toString())} | sudo sh -s -- --purge --yes`;
  const uninstallWindows = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 60 -ErrorAction Stop -Uri ${powershellQuote(new URL("/runner/uninstall.ps1", publicBase).toString())}).Content)) --purge --yes"`;
  const removalCommands = bootstrap ? { linux: uninstallShell, macos: uninstallShell, windows: uninstallWindows } : {
    linux: "sudo /opt/runmesh/current/bin/runmesh uninstall --purge --yes",
    macos: "sudo /opt/runmesh/current/bin/runmesh uninstall --purge --yes",
    windows: "& 'C:\\Program Files\\Runmesh\\current\\runmesh.cmd' uninstall --purge --yes",
  };
  const removalBlock = `<details class="panel"><summary><strong>Remove this Runner from the host</strong></summary><p class="muted font-12">Run the command for the local OS to stop and remove the managed service and local credential profile. Delete the Runner record separately from the administrator console when you no longer need its history.</p><p><strong>Linux / macOS</strong></p><pre><code>${escapeHtml(removalCommands.linux)}</code></pre><p><strong>Windows PowerShell (Administrator)</strong></p><pre><code>${escapeHtml(removalCommands.windows)}</code></pre></details>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane enrollment</title>${adminStyles()}</head><body class="ops-body enrollment-body"><a class="skip-link" href="#main-content">Skip to main content</a>${controlHeader("runners")}<main class="shell enrollment-shell" id="main-content" tabindex="-1"><dialog open aria-labelledby="enrollment-title" class="enrollment-dialog"><section class="page-heading"><div><p class="eyebrow">${title}</p><h1 id="enrollment-title">Enroll Runner</h1><p class="lede">${instruction} ${enrollmentSummary}</p></div></section><div class="enrollment-meta-box"><span class="form-stat-label">Target Runner ID</span><span class="mono"><span data-no-i18n>${escapeHtml(runnerId)}</span></span></div><div class="enrollment-meta-box"><span class="form-stat-label">Selected execution mode</span><span class="mono">${escapeHtml(modeLabel)}</span></div><div class="enrollment-meta-box"><span class="form-stat-label">One-time enrollment code</span><code class="mono" data-no-i18n>${escapeHtml(code)}</code><span class="muted font-12">${commands === manualCommands ? "Paste it only into the local prompt after verification; it is deliberately excluded from copied commands." : "The copied command includes this one-time code. Treat it as a secret and use it only once."}</span></div><div role="tablist" aria-label="Operating system" class="tabs">${tabs}</div><div class="enrollment-command-panels">${panels}</div>${warningBlock}<p class="warning">Do not share this code. It is single-use enrollment material, not an administrator password, MCP secret, or long-term credential.</p>${removalBlock}<div class="top-actions dialog-actions"><form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/enrollment">${executionModeFormFields(executionMode, csrf)}${windowFields("code", maxValidityDays)}<button class="button secondary">Regenerate enrollment</button></form><a class="button" href="/admin/runners">Done</a></div></dialog></main>${adminScript()}</body></html>`;
}
