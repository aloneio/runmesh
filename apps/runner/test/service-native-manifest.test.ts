import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderService, serviceLayout, serviceProfilePath, type ServiceManifest, type ServicePlatform } from "../src/service.js";
import { ensureManagedServiceDefinition, managedServiceManifestFromContent, rewriteManagedServiceExecutionMode } from "../src/services/manifest.js";
import { ownedManifest, parseOwnedManifest } from "../src/services/manifest-ownership.js";
import { renderMaintenanceManager } from "../src/updates/manager-install.js";
import { resolveTrustedWindowsTool, trustedWindowsEnvironment, trustedWindowsRoot } from "../src/windows-tools.js";

function previousXml(manifest: ServiceManifest): ServiceManifest {
  let body = parseOwnedManifest(manifest.content, "runner")!.body;
  body = body.replace(/<(ExecutionTimeLimit|DisallowStartIfOnBatteries|StopIfGoingOnBatteries)>[^<]*<\/\1>/gu, "");
  if (manifest.platform === "win32" && manifest.mode === "system") body = body.replace("</UserId>", "</UserId><LogonType>ServiceAccount</LogonType>");
  return { ...manifest, ...ownedManifest(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, manifest.platform, "runner") };
}

describe("native service manifest ownership and installation repair", () => {
  it.each(["linux", "darwin", "win32"] as const)("keeps %s owners distinct and binds the complete body", platform => {
    const { content } = renderService({ platform });
    expect(parseOwnedManifest(content, "runner")).toBeDefined();
    expect(parseOwnedManifest(content, "maintenance")).toBeUndefined();
    expect(parseOwnedManifest(`preamble\n${content}`, "runner")).toBeUndefined();
    expect(parseOwnedManifest(`${content}changed`, "runner")).toBeUndefined();
    const other = ownedManifest(parseOwnedManifest(content, "runner")!.body, platform, "maintenance").content;
    expect(parseOwnedManifest(other, "runner")).toBeUndefined();
    expect(parseOwnedManifest(other, "maintenance")).toBeDefined();
  });

  it.each(["darwin", "win32"] as const)("repairs existing %s installation definitions without changing rollback bytes", platform => {
    const current = renderService({ platform, executablePath: platform === "win32" ? "C:\\Runner & custom\\runmesh.cmd" : "/opt/custom & runner/bin/runmesh" });
    const prior = previousXml(current);
    const rollback = managedServiceManifestFromContent(current, prior.content);
    expect(rollback.content).toBe(prior.content);
    const repaired = ensureManagedServiceDefinition(rollback);
    expect(repaired.content).not.toContain("<?xml");
    expect(repaired.content).not.toContain("<LogonType>ServiceAccount</LogonType>");
    expect(repaired.content).toContain("custom");
    expect(parseOwnedManifest(repaired.content, "runner")).toBeDefined();
    expect(ensureManagedServiceDefinition(repaired)).toBe(repaired);
    expect(rollback.content).toBe(prior.content);
    expect(rewriteManagedServiceExecutionMode(current, prior.content, "privileged_host").content).not.toContain("<?xml");
  });

  it("retains explicit operator settings while filling only missing daemon defaults", () => {
    const prior = previousXml(renderService({ platform: "win32" }));
    const body = parseOwnedManifest(prior.content, "runner")!.body.replace("<Settings>", "<Settings><ExecutionTimeLimit>PT48H</ExecutionTimeLimit><StopIfGoingOnBatteries>true</StopIfGoingOnBatteries><Priority>6</Priority>");
    const repaired = ensureManagedServiceDefinition({ ...prior, ...ownedManifest(body, "win32", "runner") });
    expect(repaired.content).toContain("<ExecutionTimeLimit>PT48H</ExecutionTimeLimit>");
    expect(repaired.content).toContain("<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>");
    expect(repaired.content).toContain("<Priority>6</Priority>");
    expect(repaired.content).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
  });
});

function definitions(platform: ServicePlatform) {
  const cases: { name: string; xml: string; sid: string | null; logon: number; elevated: number; command: string; label: string }[] = [];
  for (const mode of ["system", "user"] as const) {
    for (const executionMode of mode === "user" ? ["dedicated_user"] as const : ["dedicated_user", "privileged_host"] as const) {
      const executablePath = platform === "win32" ? "C:\\Runner & custom path\\runmesh.cmd" : "/opt/custom & runner/bin/runmesh";
      const rendered = renderService({ platform, mode, executionMode, executablePath });
      const identity = { sid: mode === "user" ? null : executionMode === "privileged_host" ? "S-1-5-18" : "S-1-5-19", logon: mode === "user" ? 3 : 5, elevated: mode === "system" && executionMode === "privileged_host" ? 1 : 0 };
      cases.push({ name: `runner-${mode}-${executionMode}`, xml: rendered.content, ...identity, command: executablePath, label: "io.alone.runmesh.runner" });
      cases.push({ name: `repaired-runner-${mode}-${executionMode}`, xml: ensureManagedServiceDefinition(previousXml(rendered)).content, ...identity, command: executablePath, label: "io.alone.runmesh.runner" });
    }
    const options = { platform, mode, home: platform === "win32" ? "C:\\Users\\Runner & operator" : "/Users/Runner & operator" };
    const layout = serviceLayout(options);
    const manager = renderMaintenanceManager({ ...options, profilePath: serviceProfilePath(layout), installRoot: layout.installRoot });
    const runtime = platform === "win32" ? `${layout.installRoot}\\manager\\runtime\\node.exe` : `${layout.installRoot}/manager/runtime/node`;
    cases.push({ name: `manager-${mode}`, xml: manager.content, sid: mode === "user" ? null : "S-1-5-18", logon: mode === "user" ? 3 : 5, elevated: mode === "system" ? 1 : 0, command: runtime, label: "io.alone.runmesh.manager" });
  }
  return cases;
}

it.skipIf(process.platform !== "win32")("parses real generated and migrated task XML in native Windows without registering tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-native-task-"));
  try {
    const cases = definitions("win32"), input = join(root, "definitions.json"), script = join(root, "parse.ps1");
    await writeFile(input, JSON.stringify(cases), "utf8");
    await writeFile(script, String.raw`param([string]$InputPath)
$ErrorActionPreference='Stop'
$PSModuleAutoLoadingPreference='None'
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$definitions=ConvertFrom-Json ([IO.File]::ReadAllText($InputPath))
$service=New-Object -ComObject Schedule.Service
try {
  $results=@(foreach($definition in $definitions) {
    $task=$service.NewTask(0)
    try {
      $task.XmlText=$definition.xml
      $sid=if($task.Principal.UserId) { ([Security.Principal.NTAccount]::new($task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value } else { $null }
      [pscustomobject]@{ name=$definition.name; limit=$task.Settings.ExecutionTimeLimit; batteryStart=$task.Settings.DisallowStartIfOnBatteries; batteryStop=$task.Settings.StopIfGoingOnBatteries; sid=$sid; logon=$task.Principal.LogonType; elevated=$task.Principal.RunLevel; command=$task.Actions.Item(1).Path; restart=$task.Settings.RestartCount }
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($task) }
  })
  ConvertTo-Json -InputObject $results -Compress
} finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($service) }
`, "utf8");
    const systemRoot = trustedWindowsRoot();
    const result = spawnSync(resolveTrustedWindowsTool("powershell.exe", systemRoot), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, input], {
      cwd: join(systemRoot, "System32"), env: trustedWindowsEnvironment(systemRoot), encoding: "utf8", timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const observations = JSON.parse(result.stdout) as Record<string, unknown>[];
    expect(observations).toHaveLength(cases.length);
    for (const [index, item] of cases.entries()) expect(observations[index], item.name).toEqual({ name: item.name, limit: "PT0S", batteryStart: false, batteryStop: false, sid: item.sid, logon: item.logon, elevated: item.elevated, command: item.command, restart: 3 });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

it.skipIf(process.platform !== "darwin")("validates real generated and migrated macOS plists without loading launchd jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-native-plist-"));
  try {
    for (const item of definitions("darwin")) {
      const path = join(root, `${item.name}.plist`);
      await writeFile(path, item.xml, "utf8");
      const lint = spawnSync("/usr/bin/plutil", ["-lint", path], { encoding: "utf8", timeout: 5_000 });
      expect(lint.error, lint.stderr).toBeUndefined(); expect(lint.status, lint.stdout + lint.stderr).toBe(0);
      const converted = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8", timeout: 5_000 });
      expect(converted.status, converted.stderr).toBe(0);
      expect(JSON.parse(converted.stdout)).toMatchObject({ Label: item.label, ProgramArguments: expect.arrayContaining([item.command]), RunAtLoad: true, KeepAlive: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
