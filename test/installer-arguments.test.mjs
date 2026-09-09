import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";

// Execute only the actual argument parser, never the installer or host-service code.
const source = readFileSync(new URL("../apps/worker/src/installer.ts", import.meta.url), "utf8");
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "installer parser boundaries must be present");
  return source.slice(start, end);
}
const posix = section("AUTO_INSTALL_DEPS=1\n", 'if [ "$(id -u)" -ne 0 ]');
const powershell = section("$EnrollmentCodeArgument = $null\n", "$InstallRoot = Join-Path");
const codes = ["A".repeat(43), "--" + "a".repeat(41), "_" + "b".repeat(41) + "-"];
function posixParse(args, action = "install") {
  return spawnSync("/bin/sh", ["-c", posix.replaceAll("__ACTION__", action) + '\nprintf "%s|%s" "$CODE_ARG_SET" "$ENROLLMENT_CODE_ARG"\n', "parser-fixture", ...args], { encoding: "utf8", timeout: 5_000 });
}
function powerShellParse(args, action = "install") {
  const directory = mkdtempSync(join(tmpdir(), "runmesh-parser-"));
  try {
    const file = join(directory, "parse.ps1");
    writeFileSync(file, "$ErrorActionPreference = 'Stop'\nfunction Read-Host { throw 'Unexpected interactive prompt' }\n" + powershell.replaceAll("__ACTION__", action) + '\nif ($CodeArgumentProvided) { [Console]::Write("1|" + (Read-EnrollmentCode $EnrollmentCodeArgument)) } else { [Console]::Write("0|") }\n');
    return spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-File", file, ...args], { encoding: "utf8", timeout: 15_000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
for (const [platform, parse, enabled] of [["POSIX", posixParse, process.platform !== "win32"], ["PowerShell", powerShellParse, process.platform === "win32"]]) {
  test(`${platform}: positional, --code and --code= inputs avoid a second prompt`, { skip: !enabled }, () => {
    for (const code of codes) {
      for (const args of [[code], ["--code", code], [`--code=${code}`], ["install", code, "--re-enroll"], ["--auto-deps", "--code", code]]) {
        const result = parse(args);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `1|${code}`);
      }
    }
  });
  test(`${platform}: maintenance requires explicit purge confirmation and no enrollment credential`, { skip: !enabled }, () => {
    const valid = parse(["--purge", "--yes"], "uninstall");
    assert.equal(valid.status, 0, valid.stderr); assert.equal(valid.stdout, "0|");
    for (const args of [[], ["--purge"], ["--yes"], [codes[0], "--purge", "--yes"]]) {
      assert.notEqual(parse(args, "uninstall").status, 0);
    }
  });
  test(`${platform}: omitted arguments retain the manual-input path`, { skip: !enabled }, () => {
    for (const args of [[], ["install"], ["--re-enroll", "--auto-deps"]]) {
      const result = parse(args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "0|");
    }
  });
  test(`${platform}: malformed, missing and duplicate codes fail without echoing input`, { skip: !enabled }, () => {
    const malformed = "invalid-fixture-code!";
    for (const args of [["--code"], ["--code="], [malformed], ["--unknown"], [codes[0], codes[1]], ["--code", codes[0], `--code=${codes[0]}`], [codes[0] + "\n"]]) {
      const result = parse(args);
      assert.notEqual(result.status, 0);
      assert.ok(!result.stdout.includes(malformed));
      assert.ok(!result.stderr.includes(malformed));
    }
  });
}
