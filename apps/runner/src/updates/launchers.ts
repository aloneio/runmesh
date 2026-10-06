import type { ServicePlatform } from "../service.js";
import { posix, win32 } from "node:path";

const managementCommands = ["install", "migrate", "stop", "restart", "uninstall"] as const;
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** These local shims are outside the signed package contents. Only service
 * management stays on the independent CLI; start/version use the selected release. */
export function renderManagedLauncher(platform: ServicePlatform, installRoot: string): string {
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(installRoot) || /[\0\r\n"]/u.test(installRoot)) throw new Error("invalid managed launcher root");
  const manager = path.join(installRoot, "manager");
  if (platform !== "win32") {
    return `#!/bin/sh\ncase "\${1-}" in\n  ${managementCommands.join("|")}) exec ${shellQuote(path.join(manager, "runtime", "node"))} ${shellQuote(path.join(manager, "runmesh.cjs"))} "$@" ;;\nesac\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$ROOT/../runtime/node" "$ROOT/../lib/node_modules/@aloneio/runmesh-runner/dist/runmesh.cjs" "$@"\n`;
  }
  const quoted = (value: string) => `"${value.replaceAll("%", "%%")}"`;
  return ["@echo off", "setlocal DisableDelayedExpansion", 'if "%~1"=="uninstall" goto maintenance_uninstall',
    ...managementCommands.filter(command => command !== "uninstall").map(command => `if "%~1"=="${command}" goto maintenance`),
    '"%~dp0runtime\\node.exe" "%~dp0runmesh.cjs" %*', "exit /b %errorlevel%", ":maintenance",
    `${quoted(path.join(manager, "runtime", "node.exe"))} ${quoted(path.join(manager, "runmesh.cjs"))} %*`, "exit /b %errorlevel%", ":maintenance_uninstall",
    // Unload this batch before purge deletes it. CMD still runs the parsed
    // command and returns its status without reopening the removed batch file.
    `(goto) 2>nul & "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quoted(path.join(manager, "uninstall.ps1"))} %*`,
    ""].join("\r\n");
}

/** Run cleanup from a private copy so Windows can delete both installed Node
 * executables. The invoking .cmd and PowerShell do not hold an installed runtime. */
export function renderWindowsMaintenanceUninstall(): string {
  return String.raw`$ErrorActionPreference='Stop'
$env:NODE_OPTIONS=$null
$env:NODE_PATH=$null
$tempParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$temporary=[IO.Path]::Combine($tempParent,'runmesh-maintenance-'+[Guid]::NewGuid().ToString('N'))
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner($identity)
foreach($sid in @($identity,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
if([IO.Directory]::Exists($temporary) -or [IO.File]::Exists($temporary)) { throw 'Maintenance temporary path already exists' }
$directory=[IO.Directory]::CreateDirectory($temporary,$acl)
$result=1
try {
  if(($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Maintenance temporary path is linked' }
  $runtime=[IO.Path]::Combine($temporary,'node.exe')
  $bundle=[IO.Path]::Combine($temporary,'runmesh.cjs')
  [IO.File]::Copy([IO.Path]::Combine($PSScriptRoot,'runtime','node.exe'),$runtime,$false)
  [IO.File]::Copy([IO.Path]::Combine($PSScriptRoot,'runmesh.cjs'),$bundle,$false)
  & $runtime $bundle @args
  $result=$LASTEXITCODE
} finally {
  $current=[IO.DirectoryInfo]::new($temporary)
  if($current.Exists -and $current.Parent.FullName.TrimEnd('\') -eq $tempParent.TrimEnd('\') -and ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    [IO.Directory]::Delete($temporary,$true)
  }
}
exit $result
`;
}
