import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
function startScript(path, environment, timeoutMs = 10000) {
  const child = spawn(windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/bin/sh",
    windows ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path] : [path],
    { windowsHide: true, env: { ...process.env, ...environment } });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  }).finally(() => clearTimeout(timer));
  return { child, completed };
}

let managedLauncher;
function windowsManagedLauncher(root) {
  if (managedLauncher === undefined) {
    const source = buildSync({ entryPoints: [fileURLToPath(new URL("../apps/runner/src/updates/launchers.ts", import.meta.url))], platform: "node", format: "cjs", bundle: true, write: false }).outputFiles[0].text;
    const module = { exports: {} };
    new Function("module", "exports", "require", source)(module, module.exports, createRequire(import.meta.url));
    managedLauncher = module.exports.renderManagedLauncher;
  }
  return managedLauncher("win32", root);
}

for (const entry of ["fresh", "refresh"]) for (const scenario of [
  { name: "first manager setup", maintenance: true, modern: true, expected: "maintenance" },
  { name: "dedicated-user first setup", maintenance: true, modern: true, mode: "dedicated_user", expected: "maintenance" },
  { name: "existing manager priority", maintenance: true, modern: true, manager: true, expected: "manager" },
  { name: "incomplete manager rejection", maintenance: true, modern: true, manager: true, incomplete: true },
  { name: "legacy package fallback", expected: "runner" },
  { name: "nonzero install result", maintenance: true, modern: true, expected: "maintenance", exitCode: 23 },
]) test(`Windows hosted ${entry} service install handles ${scenario.name}${scenario.incomplete ? " without invoking a CLI" : " exactly once"}`, { skip: !windows }, async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "runmesh-service-entry-")));
  const root = join(temporary, "managed installation");
  const version = join(root, "versions", "fixture-version");
  const current = join(root, "current");
  const manager = join(root, "manager");
  const log = join(temporary, "calls.jsonl");
  const fixture = join(temporary, "fixture.json");
  const profile = join(temporary, "profile.json");
  const manifest = join(temporary, "native-service.xml");
  const script = join(temporary, "install.ps1");
  const managerSource = join(temporary, "manager-source.cjs");
  const installLog = join(temporary, "service-install.log");
  const template = join(temporary, "managed-wrapper.txt");
  const wrapper = windowsManagedLauncher(root);
  const mode = scenario.mode ?? "privileged_host";
  const generated = loaded.exports.renderPowerShellInstaller("https://installer.example.test", mode);
  const program = role => `const fs=require('node:fs'),path=require('node:path');
const c=JSON.parse(fs.readFileSync(process.env.RUNMESH_SERVICE_FIXTURE,'utf8')),args=process.argv.slice(2),role=${JSON.stringify(role)};
if(args[0]!=='install')throw Error('Unexpected service fixture command');
fs.appendFileSync(c.log,JSON.stringify({role,args,runtime:process.execPath})+'\\n');
console.log('fixture service install exit '+c.exitCode);
if(c.exitCode){process.exitCode=c.exitCode;return;}
if(c.modern){
  if(!fs.existsSync(c.manager)){fs.mkdirSync(path.join(c.manager,'runtime'),{recursive:true});fs.copyFileSync(process.execPath,path.join(c.manager,'runtime','node.exe'));fs.copyFileSync(c.managerSource,path.join(c.manager,'runmesh.cjs'));}
  const wrapper=fs.readFileSync(c.template);
  for(const name of ['runmesh.cmd','runmesh-runner.cmd']){const destination=path.join(c.current,name);if(fs.readFileSync(destination).equals(wrapper))continue;const temporary=destination+'.fixture.tmp';fs.writeFileSync(temporary,wrapper);fs.renameSync(temporary,destination);}
}
`;
  try {
    await mkdir(join(version, "runtime"), { recursive: true });
    await copyFile(process.execPath, join(version, "runtime", "node.exe"));
    await writeFile(join(version, "runmesh.cjs"), program("runner"));
    await writeFile(managerSource, program("manager"));
    if (scenario.maintenance) {
      const dist = join(version, "node_modules/@aloneio/runmesh-runner/dist");
      await mkdir(dist, { recursive: true });
      await writeFile(join(dist, "maintenance.cjs"), program("maintenance"));
    }
    if (scenario.manager) {
      await mkdir(join(manager, "runtime"), { recursive: true });
      await copyFile(process.execPath, join(manager, "runtime", "node.exe"));
      if (!scenario.incomplete) await copyFile(managerSource, join(manager, "runmesh.cjs"));
    }
    await symlink(version, current, "junction");
    await writeFile(template, wrapper);
    await writeFile(profile, JSON.stringify({ runner_id: "fixture-runner", execution_mode: mode, token: "fixture-only-token" }));
    await writeFile(manifest, "unchanged synthetic native service");
    const retained = await Promise.all([profile, manifest].map(path => readFile(path)));
    await writeFile(fixture, JSON.stringify({ current, manager, managerSource, log, template, modern: scenario.modern === true, exitCode: scenario.exitCode ?? 0 }));
    const source = `$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$InstallRoot=$env:RUNMESH_SERVICE_ROOT
$CurrentRoot=Join-Path $InstallRoot 'current'
$Stage=Join-Path $InstallRoot 'versions\\fixture-version'
$Profile=$env:RUNMESH_SERVICE_PROFILE
$CurrentRunner=Join-Path $CurrentRoot 'runmesh.cmd'
$ExistingRunner=$CurrentRunner
$ServiceLog=$env:RUNMESH_SERVICE_LOG
$EnrollmentAttempted=$true
$crlf=[Environment]::NewLine
$dq=[char]34
$global:LASTEXITCODE=0
${section(generated, "$script:StepIndex = 0", "function Refresh-Existing")}
${section(generated, "  $Runner = Join-Path $Stage 'runmesh.cmd'", "  if ((& $Runner --version)")}
${entry === "fresh" ? section(generated, "  Invoke-LoggedStep 'Starting service'", "  $Succeeded = $true")
      : section(generated, "    $RefreshInstallLog =", "    $RefreshRestartLog =")}
`;
    await writeFile(script, source);
    const result = await startScript(script, { RUNMESH_SERVICE_ROOT: root, RUNMESH_SERVICE_PROFILE: profile,
      RUNMESH_SERVICE_LOG: installLog, RUNMESH_SERVICE_FIXTURE: fixture,
      NODE_OPTIONS: "", NODE_PATH: "" }).completed;
    const called = await readFile(log, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    const calls = called.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (scenario.incomplete) {
      assert.notEqual(result.code, 0, "an incomplete manager must not fall back to the selected Runner");
      assert.match(result.stdout + result.stderr, /Installed service maintenance entry is incomplete/);
      assert.deepEqual(calls, []);
    } else {
      if (scenario.exitCode) {
        assert.notEqual(result.code, 0, "the generated caller must observe the native CLI failure");
        assert.match(result.stdout + result.stderr, entry === "fresh" ? /Starting service/ : /Service installation refresh failed/);
      } else assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(calls.length, 1, `one generated ${entry} install must invoke its service CLI once: ${JSON.stringify(calls)}`);
      assert.equal(calls[0].role, scenario.expected, result.stdout + result.stderr);
      assert.deepEqual(calls[0].args, ["install", "--profile", profile, "--execution-mode", mode, ...(mode === "privileged_host" ? ["--confirm-privileged-host"] : []), "--executable-path", join(current, "runmesh.cmd")]);
    }
    assert.equal(await realpath(current), await realpath(version));
    for (const [index, path] of [profile, manifest].entries()) assert.deepEqual(await readFile(path), retained[index]);
  } finally {
    assert.equal(dirname(temporary), await realpath(tmpdir()));
    await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

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

for (const scenario of [
  { name: "nonzero uninstall", exitCode: 23, retain: true, expected: "maintenance" },
  { name: "uninstall exception", throws: true, retain: true, expected: "maintenance" },
  { name: "missing runtime", missingRuntime: true, retain: true },
  { name: "missing entry", missingEntry: true, retain: true },
  { name: "successful uninstall", expected: "maintenance" },
  { name: "missing mutable launcher", noWrapper: true, expected: "maintenance" },
  { name: "failure before service attempt", attempted: false },
  { name: "retained manager failure", manager: true, managerExitCode: 29, retain: true, expected: "manager" },
  { name: "incomplete retained manager", manager: true, incompleteManager: true, retain: true },
  { name: "retained manager success", manager: true, exitCode: 23, expected: "manager" },
  { name: "legacy entry fallback", legacy: true, expected: "runner" },
]) test(`hosted service rollback handles ${scenario.name}`, async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "runmesh-service-rollback-")));
  const root = join(temporary, "managed installation");
  const version = join(root, "versions", "fixture-version");
  const current = join(root, "current");
  const manager = join(root, "manager");
  const profile = join(root, "profile.json");
  const callsFile = join(temporary, "calls.jsonl");
  const fixtureFile = join(temporary, "fixture.json");
  const file = join(temporary, windows ? "rollback.ps1" : "rollback.sh");
  const runtime = join(version, "runtime", windows ? "node.exe" : "node");
  const dist = join(version, ...(windows ? [] : ["lib"]), "node_modules/@aloneio/runmesh-runner/dist");
  const entry = scenario.legacy ? join(version, ...(windows ? ["runmesh.cjs"] : ["lib/node_modules/@aloneio/runmesh-runner/dist/runmesh.cjs"])) : join(dist, "maintenance.cjs");
  const attempted = scenario.attempted !== false;
  const program = role => `const fs=require('node:fs'),assert=require('node:assert/strict');
const c=JSON.parse(fs.readFileSync(process.env.RUNMESH_ROLLBACK_FIXTURE,'utf8')),args=process.argv.slice(2),role=${JSON.stringify(role)};
assert.deepEqual(args,['uninstall','--profile',c.profile,'--json']);
fs.appendFileSync(c.callsFile,JSON.stringify({role,args})+'\\n');
if(c.throws)throw Error('fixture uninstall exception');
process.exit(role==='manager'?c.managerExitCode:c.exitCode);
`;
  try {
    for (const path of [join(version, "runtime"), dist, join(version, "bin"), join(root, "stage"), join(root, "temp")]) await mkdir(path, { recursive: true });
    if (!scenario.missingRuntime) await copyFile(process.execPath, runtime);
    if (!scenario.missingEntry) await writeFile(entry, program(scenario.legacy ? "runner" : "maintenance"));
    if (scenario.manager) {
      await mkdir(join(manager, "runtime"), { recursive: true });
      await copyFile(process.execPath, join(manager, "runtime", windows ? "node.exe" : "node"));
      if (!scenario.incompleteManager) await writeFile(join(manager, "runmesh.cjs"), program("manager"));
      await writeFile(join(manager, "recovery-marker"), "retained manager state");
    }
    await writeFile(profile, "owned profile for recovery");
    await writeFile(join(version, "recovery-marker"), "owned version for recovery");
    await writeFile(join(root, "temp", "private-download"), "private installer download");
    await symlink(version, current, windows ? "junction" : "dir");
    await writeFile(fixtureFile, JSON.stringify({ profile, callsFile, throws: scenario.throws === true, exitCode: scenario.exitCode ?? 0, managerExitCode: scenario.managerExitCode ?? 0 }));
    if (!scenario.noWrapper) {
      if (windows) await writeFile(join(version, "runmesh.cmd"), `@echo off\r\n"${runtime}" "${entry}" %*\r\n`);
      else await writeFile(join(version, "bin", "runmesh"), `#!/bin/sh\nexec "${runtime}" "${entry}" "$@"\n`, { mode: 0o755 });
    }
    const source = windows ? `$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$InstallRoot=$env:RUNMESH_ROLLBACK_ROOT
$Profile=Join-Path $InstallRoot 'profile.json'
$CurrentRoot=Join-Path $InstallRoot 'current'
$CurrentNew=Join-Path $InstallRoot 'current.new'
$Stage=Join-Path $InstallRoot 'stage'
$VersionRoot=Join-Path $InstallRoot 'versions\\fixture-version'
$TempRoot=Join-Path $InstallRoot 'temp'
$CurrentRunner=Join-Path $CurrentRoot 'runmesh.cmd'
$Succeeded=$false; $MaintenanceAction='install'; $EnrollmentAttempted=$true; $ServiceAttempted=${attempted ? "$true" : "$false"}
$ProfileCreated=$true; $CurrentCreated=$true; $CurrentNewCreated=$false; $StageCreated=$true; $VersionCreated=$true
$global:LASTEXITCODE=37
${section(powershell, "$script:StepIndex = 0", "function Refresh-Existing")}
try { throw 'fixture original install failure' } finally {
${section(powershell, "  if (-not $Succeeded -and $MaintenanceAction", "\n}\n} finally {")}
Write-Host ('ROLLBACK_EXIT_CODE=' + $LASTEXITCODE)
}
` : `#!/bin/sh
set -eu
INSTALL_ROOT="$RUNMESH_ROLLBACK_ROOT"
PROFILE="$INSTALL_ROOT/profile.json"
CURRENT_NEW="$INSTALL_ROOT/current.new"
STAGE="$INSTALL_ROOT/stage"
FINAL="$INSTALL_ROOT/versions/fixture-version"
TMP="$INSTALL_ROOT/temp"
TTY_ECHO_DISABLED=0; INSTALL_PHASE=service_install; RUNMESH_ACTION=install; ENROLLMENT_ATTEMPTED=1
PROFILE_CREATED=1; CURRENT_CREATED=1; CURRENT_NEW_CREATED=0; STAGE_CREATED=1; FINAL_CREATED=1; SERVICE_ATTEMPTED=${attempted ? "1" : "0"}
release_install_lock() { printf '%s' released > "$RUNMESH_ROLLBACK_LOCK_RELEASE"; }
${section(posix, "cleanup_tty()", "on_exit()")}
rollback 37
`;
    await writeFile(file, source);
    const releasedLock = join(temporary, "lock-released");
    const result = await startScript(file, { RUNMESH_ROLLBACK_ROOT: root, RUNMESH_ROLLBACK_FIXTURE: fixtureFile, RUNMESH_ROLLBACK_LOCK_RELEASE: releasedLock, NODE_OPTIONS: "", NODE_PATH: "" }, 30000).completed;
    const output = result.stdout + result.stderr;
    assert.equal(result.code, windows ? 1 : 37, output);
    if (windows) {
      assert.match(output, /fixture original install failure/);
      assert.match(output, /ROLLBACK_EXIT_CODE=37/);
    } else assert.equal(await readFile(releasedLock, "utf8"), "released");
    const retain = scenario.retain === true;
    for (const path of [profile, current, version]) assert.equal(await lstat(path).then(() => true, () => false), retain, `${path}: recovery state ${retain ? "must remain" : "must be cleaned"}`);
    if (retain) {
      assert.equal(await realpath(current), await realpath(version));
      assert.equal(await readFile(profile, "utf8"), "owned profile for recovery");
      assert.equal(await readFile(join(version, "recovery-marker"), "utf8"), "owned version for recovery");
      assert.match(output, /retained.*recovery/i);
    }
    if (scenario.manager) assert.equal(await readFile(join(manager, "recovery-marker"), "utf8"), "retained manager state");
    for (const path of ["stage", "temp"]) assert.equal(await lstat(join(root, path)).then(() => true, () => false), false, `${path} is private installer state`);
    const called = await readFile(callsFile, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    const calls = called.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.role), scenario.expected ? [scenario.expected] : []);
  } finally {
    assert.equal(dirname(temporary), await realpath(tmpdir()));
    await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
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
SERVICE_ATTEMPTED=0
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
RUNMESH_ACTION=${action}; INSTALL_PHASE=release_verification; ENROLLMENT_ATTEMPTED=0; SERVICE_ATTEMPTED=0; TTY_ECHO_DISABLED=0
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
