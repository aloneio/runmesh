import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Run only locking/rollback/maintenance fragments from the generated installer.
// All filesystem paths and mutex names belong to private test fixtures.
const compiled = buildSync({ entryPoints: [fileURLToPath(new URL("../apps/worker/src/installer.ts", import.meta.url))], platform: "node", format: "cjs", bundle: true, write: false }).outputFiles[0].text;
const loaded = { exports: {} };
new Function("module", "exports", compiled)(loaded, loaded.exports);
const posix = loaded.exports.renderPosixInstaller("https://installer.example.test");
const powershell = loaded.exports.renderPowerShellInstaller("https://installer.example.test");
const windows = process.platform === "win32";
function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
function startScript(path, environment) {
  const child = spawn(windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/sh",
    windows ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path] : [path],
    { windowsHide: true, env: { ...process.env, ...environment } });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const timer = setTimeout(() => child.kill(), 10000);
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  }).finally(() => clearTimeout(timer));
  return { child, completed };
}

test("hosted installer lock excludes a second process and releases on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-installer-lock-"));
  const file = join(root, windows ? "lock.ps1" : "lock.sh");
  const source = windows
    ? "$ErrorActionPreference='Stop'\n" + section(powershell, "$InstallerMutex =", "$script:StepIndex =")
      .replace("'Global\\RunmeshInstaller-v1'", `'Local\\RunmeshInstaller-test-${randomUUID()}'`)
      + `[Console]::WriteLine('LOCKED')
if ($env:RUNMESH_HOLD_LOCK -eq 'yes') {
  while (-not (Test-Path -LiteralPath $env:RUNMESH_RELEASE_LOCK)) { Start-Sleep -Milliseconds 25 }
  throw 'fixture failure'
}
} finally {
  if ($InstallerLockHeld) { $InstallerMutex.ReleaseMutex() }
  $InstallerMutex.Dispose()
}
`
    : "#!/bin/sh\nset -eu\n" + section(posix, "INSTALL_LOCK=", "has_path()")
      .replace("INSTALL_LOCK='/var/run/runmesh-installer.lock'", 'INSTALL_LOCK="$RUNMESH_TEST_LOCK"')
      + `printf '%s\\n' LOCKED
if [ "$RUNMESH_HOLD_LOCK" = yes ]; then
  while [ ! -f "$RUNMESH_RELEASE_LOCK" ]; do sleep 0.025; done
  exit 1
fi
`;
  await writeFile(file, source);
  const environment = { RUNMESH_TEST_LOCK: join(root, "lock"), RUNMESH_RELEASE_LOCK: join(root, "release"), RUNMESH_HOLD_LOCK: "yes" };
  const holder = startScript(file, environment);
  try {
    await Promise.race([
      new Promise(resolve => holder.child.stdout.on("data", data => { if (data.toString().includes("LOCKED")) resolve(); })),
      holder.completed.then(result => { throw new Error(`lock holder exited: ${JSON.stringify(result)}`); }),
    ]);
    const denied = await startScript(file, { ...environment, RUNMESH_HOLD_LOCK: "no" }).completed;
    assert.notEqual(denied.code, 0, denied.stdout + denied.stderr);
    assert.match(denied.stdout + denied.stderr, /another Runmesh installer or uninstaller is running/i);
    await writeFile(environment.RUNMESH_RELEASE_LOCK, "release");
    assert.notEqual((await holder.completed).code, 0);
    const allowed = await startScript(file, { ...environment, RUNMESH_HOLD_LOCK: "no" }).completed;
    assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
    assert.match(allowed.stdout, /LOCKED/);
  } finally {
    holder.child.kill();
    await holder.completed;
    await rm(root, { recursive: true, force: true });
  }
});

for (const owned of [false, true]) test(`installer rollback ${owned ? "removes owned" : "preserves another attempt's"} profile and paths`, async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-installer-rollback-"));
  const file = join(root, windows ? "rollback.ps1" : "rollback.sh");
  for (const name of ["stage", "version", "temp"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "marker"), "fixture");
  }
  await writeFile(join(root, "profile.json"), "other enrollment fixture");
  if (!windows) {
    await mkdir(join(root, "version", "bin"));
    await writeFile(join(root, "version", "bin", "runmesh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await symlink(join(root, "version"), join(root, "current"));
    await symlink(join(root, "version"), join(root, "current.new"));
  }
  const flag = windows ? (owned ? "$true" : "$false") : (owned ? "1" : "0");
  const source = windows ? `$ErrorActionPreference='Stop'
$InstallRoot=$env:RUNMESH_ROLLBACK_ROOT
$Profile=Join-Path $InstallRoot 'profile.json'
$CurrentRoot=Join-Path $InstallRoot 'current'
$CurrentNew=Join-Path $InstallRoot 'current.new'
$Stage=Join-Path $InstallRoot 'stage'
$VersionRoot=Join-Path $InstallRoot 'version'
$TempRoot=Join-Path $InstallRoot 'temp'
New-Item -ItemType Junction -Path $CurrentRoot -Target $VersionRoot | Out-Null
New-Item -ItemType Junction -Path $CurrentNew -Target $VersionRoot | Out-Null
$Succeeded=$false; $MaintenanceAction='install'; $EnrollmentAttempted=$true; $ServiceAttempted=$false; $CurrentRunner=$null
$ProfileCreated=${flag}; $CurrentCreated=${flag}; $CurrentNewCreated=${flag}; $StageCreated=${flag}; $VersionCreated=${flag}
${section(powershell, "  if (-not $Succeeded -and $MaintenanceAction", "  if (Test-Path -LiteralPath $TempRoot)")}
` : `#!/bin/sh
set -eu
INSTALL_ROOT="$RUNMESH_ROLLBACK_ROOT"
PROFILE="$INSTALL_ROOT/profile.json"
CURRENT_NEW="$INSTALL_ROOT/current.new"
STAGE="$INSTALL_ROOT/stage"
FINAL="$INSTALL_ROOT/version"
TMP="$INSTALL_ROOT/temp"
TTY_ECHO_DISABLED=0
INSTALL_PHASE=enrollment
RUNMESH_ACTION=install
ENROLLMENT_ATTEMPTED=1
PROFILE_CREATED=${flag}
CURRENT_CREATED=${flag}
CURRENT_NEW_CREATED=${flag}
STAGE_CREATED=${flag}
FINAL_CREATED=${flag}
release_install_lock() { :; }
${section(posix, "cleanup_tty()", "on_exit()")}
rollback 1
`;
  await writeFile(file, source);
  try {
    const result = await startScript(file, { RUNMESH_ROLLBACK_ROOT: root }).completed;
    assert.equal(result.code, windows ? 0 : 1, result.stdout + result.stderr);
    for (const path of ["profile.json", "stage/marker", "version/marker"]) {
      const present = await readFile(join(root, path)).then(() => true, () => false);
      assert.equal(present, !owned, `${path} ownership was ignored`);
    }
    for (const path of ["current", "current.new"]) {
      assert.equal(await lstat(join(root, path)).then(() => true, () => false), !owned, `${path} ownership was ignored`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generated installers remain syntactically valid after cleanup guards", async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-installer-parse-"));
  try {
    for (const action of ["Installer", "Uninstaller"]) {
      const generated = loaded.exports[`render${windows ? "PowerShell" : "Posix"}${action}`]("https://installer.example.test");
      const file = join(root, windows ? "generated.ps1" : "generated.sh");
      await writeFile(file, generated);
      const parse = join(root, windows ? "parse.ps1" : "parse.sh");
      await writeFile(parse, windows
        ? "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:RUNMESH_PARSE_FILE,[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }"
        : '#!/bin/sh\n/bin/sh -n "$RUNMESH_PARSE_FILE"\n');
      const result = await startScript(parse, { RUNMESH_PARSE_FILE: file }).completed;
      assert.equal(result.code, 0, result.stdout + result.stderr);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: "successful cleanup", preparation: 0, purge: 0 },
  { name: "cleanup tool failure", preparation: 17, purge: 0 },
  { name: "incomplete cleanup", preparation: 0, purge: 23 },
  { name: "verification failure before cleanup", preparation: 0, purge: 0, verification: 19 },
  { name: "installation failure keeps enrollment guidance", preparation: 0, purge: 0, verification: 19, action: "install" },
]) test(`hosted maintenance reports ${scenario.name} without losing its outcome`, async () => {
  const root = await mkdtemp(join(tmpdir(), "runmesh-maintenance-result-"));
  const action = scenario.action ?? "uninstall";
  const file = join(root, windows ? "maintenance.ps1" : "maintenance.sh");
  const temp = join(root, "temp");
  const maintenance = join(temp, "maintenance", ...(windows ? [] : ["lib"]), "node_modules/@aloneio/runmesh-runner/dist");
  await mkdir(maintenance, { recursive: true });
  for (const name of ["stage", "version"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "marker"), "existing installation");
  }
  await writeFile(join(root, "profile.json"), "existing profile");
  const npmFixture = join(root, "npm-fixture.cjs");
  const npmCommand = join(root, "npm-fixture.ps1");
  await writeFile(npmFixture, `process.stdout.write("fixture preparation\\n"); process.exit(${scenario.preparation});\n`);
  await writeFile(npmCommand, '& $env:RUNMESH_TEST_NODE $env:RUNMESH_TEST_NPM\nexit $LASTEXITCODE\n');
  await writeFile(join(maintenance, "runmesh.cjs"), `require("node:assert/strict").deepEqual(process.argv.slice(2), ["uninstall", "--purge", "--yes"]); process.stdout.write("fixture cleanup\\n"); process.exit(${scenario.purge});\n`);
  const source = windows ? `$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$InstallRoot=$env:RUNMESH_TEST_ROOT
$TempRoot=Join-Path $InstallRoot 'temp'
$Profile=Join-Path $InstallRoot 'profile.json'
$Stage=Join-Path $InstallRoot 'stage'
$VersionRoot=Join-Path $InstallRoot 'version'
$CurrentRoot=Join-Path $InstallRoot 'current'
$CurrentNew=Join-Path $InstallRoot 'current.new'
$NodePath=$env:RUNMESH_TEST_NODE; $NpmPath=$env:RUNMESH_TEST_NPM_COMMAND
$EmptyUserConfig='fixture'; $EmptyGlobalConfig='fixture'; $ArtifactName='fixture.tgz'
$MaintenanceAction='${action}'; $RuntimePhase='release_verification'; $EnrollmentAttempted=$false
$Succeeded=$false; $ServiceAttempted=$false; $CurrentRunner=$null; $HttpClient=$null; $HttpHandler=$null
$ProfileCreated=$true; $StageCreated=$true; $VersionCreated=$true; $CurrentCreated=$false; $CurrentNewCreated=$false
$global:LASTEXITCODE=0
${section(powershell, "$script:StepIndex = 0", "function Refresh-Existing")}
try {
${scenario.verification ? "throw 'fixture verification failure'" : ""}
${section(powershell, "  if ($MaintenanceAction -eq 'uninstall') {", "  New-Item -ItemType Directory -Path $VersionsRoot")}
  throw 'Unexpected installation path'
${section(powershell.slice(powershell.indexOf("  Write-Host ('  Status:")), "} catch {", "\n} finally {\n  if ($InstallerLockHeld)")}
` : `#!/bin/sh
set -eu
INSTALL_ROOT="$RUNMESH_TEST_ROOT"
TMP="$INSTALL_ROOT/temp"
PROFILE="$INSTALL_ROOT/profile.json"
STAGE="$INSTALL_ROOT/stage"
FINAL="$INSTALL_ROOT/version"
CURRENT_NEW="$INSTALL_ROOT/current.new"
NODE="$RUNMESH_TEST_NODE"
NPM_CLI="$RUNMESH_TEST_NPM"
NPM_CONFIG_USERCONFIG=fixture; NPM_CONFIG_GLOBALCONFIG=fixture; ARTIFACT=fixture.tgz
RUNMESH_ACTION=${action}; INSTALL_PHASE=release_verification; ENROLLMENT_ATTEMPTED=0; TTY_ECHO_DISABLED=0
PROFILE_CREATED=1; STAGE_CREATED=1; FINAL_CREATED=1; CURRENT_CREATED=0; CURRENT_NEW_CREATED=0
C_CYAN=''; C_GREEN=''; C_RED=''; C_RESET=''
${section(posix, "STEP_INDEX=0", "printf '\\n%bRunmesh Runner")}
release_install_lock() { :; }
${section(posix, "cleanup_tty()", "# Follow redirects one hop")}
${scenario.verification ? `printf '%s\\n' 'fixture verification failure' >&2; exit ${scenario.verification}` : ""}
${section(posix, "ok 'Runner verified.'", 'mkdir -p "$INSTALL_ROOT/versions"')}
exit 99
`;
  await writeFile(file, source);
  try {
    const result = await startScript(file, { RUNMESH_TEST_ROOT: root, RUNMESH_TEST_NODE: process.execPath,
      RUNMESH_TEST_NPM: npmFixture, RUNMESH_TEST_NPM_COMMAND: npmCommand }).completed;
    const expected = scenario.verification || scenario.preparation || scenario.purge;
    const output = result.stdout + result.stderr;
    assert.equal(result.code, windows && expected ? 1 : expected, output);
    if (expected) {
      const phase = scenario.verification ? "release_verification" : "cleanup";
      assert.ok(output.includes(`[RMI_${action === "install" ? "INSTALL" : "UNINSTALL"}_FAILED] stage=${phase}`), output);
      if (action === "uninstall") assert.doesNotMatch(output, /RMI_INSTALL_FAILED|Enrollment|rolled back/);
      else assert.match(output, /Enrollment was not attempted/);
      assert.match(output, scenario.verification ? /fixture verification failure/ : scenario.preparation ? /fixture preparation/ : /fixture cleanup/);
    } else assert.doesNotMatch(output, /RMI_.*_FAILED|Enrollment/);
    if (scenario.verification || scenario.preparation) assert.doesNotMatch(output, /fixture cleanup/);
    if (action === "uninstall") for (const path of ["profile.json", "stage/marker", "version/marker"]) {
      assert.match(await readFile(join(root, path), "utf8"), /^existing /, `${path} must survive uninstall failure reporting`);
    }
    assert.equal(await lstat(temp).then(() => true, () => false), false, "private maintenance files must be removed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
