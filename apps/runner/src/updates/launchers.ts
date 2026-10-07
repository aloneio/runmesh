import type { ServicePlatform } from "../service.js";
import { MAINTENANCE_SERVICE_COMMANDS } from "../maintenance-contract.js";
import { posix, win32 } from "node:path";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** These local shims are outside the signed package contents. Only service
 * management stays on the independent CLI; start/version use the selected release. */
export function renderManagedLauncher(platform: ServicePlatform, installRoot: string): string {
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(installRoot) || /[\0\r\n"]/u.test(installRoot)) throw new Error("invalid managed launcher root");
  const manager = path.join(installRoot, "manager");
  if (platform !== "win32") {
    return `#!/bin/sh\ncase "\${1-}" in\n  ${MAINTENANCE_SERVICE_COMMANDS.join("|")}) exec ${shellQuote(path.join(manager, "runtime", "node"))} ${shellQuote(path.join(manager, "runmesh.cjs"))} "$@" ;;\nesac\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$ROOT/../runtime/node" "$ROOT/../lib/node_modules/@aloneio/runmesh-runner/dist/runmesh.cjs" "$@"\n`;
  }
  const quoted = (value: string) => `"${value.replaceAll("%", "%%")}"`;
  return ["@echo off", "setlocal DisableDelayedExpansion", 'if "%~1"=="uninstall" goto maintenance_uninstall',
    ...MAINTENANCE_SERVICE_COMMANDS.filter(command => command !== "uninstall").map(command => `if "%~1"=="${command}" goto maintenance`),
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
  $cleanupTimer=[Diagnostics.Stopwatch]::StartNew()
  try {
    while($true) {
      $current=[IO.DirectoryInfo]::new($temporary)
      if(-not $current.Exists) { break }
      if($current.Parent.FullName.TrimEnd('\') -ne $tempParent.TrimEnd('\') -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Maintenance temporary path changed before cleanup'
      }
      try {
        [IO.Directory]::Delete($temporary,$true)
        break
      } catch {
        # The command has exited, but Windows may still hold its image or a
        # scanner handle. Retry only sharing/lock violations, within one budget.
        $failure=$_.Exception
        $locked=$false
        while($null -ne $failure) {
          if($failure -is [IO.IOException] -and ($failure.HResult -band 65535) -in @(32,33)) { $locked=$true; break }
          $failure=$failure.InnerException
        }
        if(-not $locked -or $cleanupTimer.ElapsedMilliseconds -ge 5000) { throw }
        [Threading.Thread]::Sleep(100)
      }
    }
  } catch {
    [Console]::Error.WriteLine('Maintenance temporary cleanup failed for "'+$temporary+'": '+$_.Exception.Message)
    if($result -eq 0) { $result=1 }
  }
}
exit $result
`;
}
