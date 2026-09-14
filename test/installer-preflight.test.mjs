import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Bundle and execute the real emitted shell functions, not a second copy of
// the implementation. Fixtures never execute an enrollment or service action.
const compiled = buildSync({ entryPoints: [fileURLToPath(new URL("../apps/worker/src/installer.ts", import.meta.url))], platform: "node", format: "cjs", bundle: true, write: false }).outputFiles[0].text;
const loaded = { exports: {} };
new Function("module", "exports", compiled)(loaded, loaded.exports);
const { renderPosixInstaller, renderPowerShellInstaller, FIXED_NODE_RUNTIME_ASSETS, FIXED_NODE_VERSION } = loaded.exports;
const shell = renderPosixInstaller("https://installer.example.test");
const start = shell.indexOf("bootstrap_error() {");
const end = shell.indexOf("\nVERSION=", start);
assert.ok(start >= 0 && end > start);
const functions = shell.slice(start, end);
const baseTools = "id uname readlink grep mkdir rmdir rm mktemp sed wc tr mv cp ln chmod cat dirname bash curl tar gzip".split(" ");
const posix = process.platform !== "win32";
function executable(name) {
  const value = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(dir => join(dir, name)).find(existsSync);
  assert.ok(value, `fixture requires host tool ${name}`); return value;
}
function fixture({ omit = [], hash = process.platform === "darwin" ? "shasum" : "sha256sum", curlExit = 0, gzipExit = 0, tarExit = 0, nodeExit = 0, libc = "glibc 2.36", serviceExit = 0, invalidHash = false, corruptGzip = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "runmesh-installer-tools-"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const home = `node-v${FIXED_NODE_VERSION}-linux-x64`;
  const archive = join(root, `${home}.tar.gz`); const tree = join(root, "fixture");
  mkdirSync(join(tree, home, "bin"), { recursive: true });
  mkdirSync(join(tree, home, "lib/node_modules/npm/bin"), { recursive: true });
  writeFileSync(join(tree, home, "bin/node"), `#!/bin/sh\n[ "${nodeExit}" -eq 0 ] || exit ${nodeExit}\nprintf '%s\\n' 'v${FIXED_NODE_VERSION}'\n`, { mode: 0o755 });
  writeFileSync(join(tree, home, "lib/node_modules/npm/bin/npm-cli.js"), "// fixture only\n");
  const tar = spawnSync(executable("tar"), ["-cf", join(root, "fixture.tar"), "-C", tree, home], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  const content = corruptGzip ? Buffer.from("not a gzip archive") : gzipSync(readFileSync(join(root, "fixture.tar")));
  writeFileSync(archive, content);
  for (const name of [...baseTools, hash]) if (!omit.includes(name) && !["curl", "uname"].includes(name)) symlinkSync(executable(name), join(bin, name));
  const stub = (name, body) => { const file = join(bin, name); if (existsSync(file)) rmSync(file); writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
  if (!omit.includes("uname")) stub("uname", 'case "$1" in -s) echo Linux;; -m) echo x86_64;; esac');
  if (!omit.includes("curl")) stub("curl", `printf 'download\\n' >> "$TEST_EVENTS"\n[ ${curlExit} -eq 0 ] || exit ${curlExit}\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; destination="$1"; fi; shift; done\n${executable("cp")} "$TEST_ARCHIVE" "$destination"`);
  stub("getconf", `printf '%s\\n' '${libc}'`);
  if (!omit.includes("systemctl")) stub("systemctl", `printf 'service-check\\n' >> "$TEST_EVENTS"\nexit ${serviceExit}`);
  if (gzipExit) stub("gzip", `exit ${gzipExit}`);
  if (tarExit) stub("tar", `exit ${tarExit}`);
  const env = { ...process.env, PATH: bin, INSTALL_PHASE: "preflight", RUNMESH_ACTION: "install", CODE_ARG_SET: "1", ENROLLMENT_ATTEMPTED: "0",
    TEST_EVENTS: join(root, "events"), TEST_ARCHIVE: archive, TMP: join(root, "tmp"), RUNTIME_ROOT: join(root, "tmp/runtime"),
    RUNTIME_ARCHIVE: join(root, "tmp/download.tar.gz"), NODE_ASSET: `${home}.tar.gz`, RUNTIME_URL: `https://nodejs.org/dist/v${FIXED_NODE_VERSION}/${home}.tar.gz`,
    NODE_SHA256: invalidHash ? "0".repeat(64) : createHash("sha256").update(content).digest("hex"), ENROLLMENT_CODE_ARG: "S".repeat(43), RUNTIME_HASH_TOOL: hash };
  mkdirSync(env.RUNTIME_ROOT, { recursive: true });
  return { root, env, run(source = "check_base_tools; check_service_prerequisites; check_bootstrap_tools; prepare_private_runtime; echo BOOTSTRAP_OK") {
    return spawnSync("/bin/sh", ["-eu", "-c", functions + "\n" + source], { env, encoding: "utf8", timeout: 10000 });
  }, events() { return existsSync(env.TEST_EVENTS) ? readFileSync(env.TEST_EVENTS, "utf8") : ""; }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test("all POSIX targets pin official gzip bytes, retaining Windows ZIP and exact Node version", () => {
  const official = {
    "linux-x64": "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a",
    "linux-arm64": "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30",
    "darwin-x64": "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
    "darwin-arm64": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  };
  for (const [name, digest] of Object.entries(official)) assert.deepEqual(FIXED_NODE_RUNTIME_ASSETS[name], { archive: `node-v${FIXED_NODE_VERSION}-${name}.tar.gz`, sha256: digest });
  assert.ok(FIXED_NODE_RUNTIME_ASSETS["win-x64"].archive.endsWith(".zip"));
  assert.ok(!shell.includes("tar -xJf") && !shell.includes(".tar.xz"));
  assert.ok(!shell.includes("__POSIX_") && !shell.includes("__NODE_") && !shell.includes("__CODE_EQUALS"));
});

test("real gzip/tar extraction succeeds without xz, awk, or system Node in PATH", { skip: !posix }, () => {
  const f = fixture();
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /BOOTSTRAP_OK/);
    assert.ok(!existsSync(join(f.env.PATH, "xz")) && !existsSync(join(f.env.PATH, "awk")) && !existsSync(join(f.env.PATH, "node")));
    assert.equal(f.events(), "service-check\ndownload\n");
  } finally { f.cleanup(); }
});

for (const hash of ["shasum", "openssl"]) test(`checksum fallback ${hash} verifies without awk`, { skip: !posix }, () => {
  const f = fixture({ hash }); try { const result = f.run(); assert.equal(result.status, 0, result.stderr); } finally { f.cleanup(); }
});

for (const options of [
  { omit: ["gzip", "tar"], code: "RMI_MISSING_TOOLS" },
  { omit: ["sha256sum", "shasum", "openssl"], code: "RMI_CHECKSUM_TOOL" },
  { omit: ["systemctl"], code: "RMI_SERVICE_MANAGER" },
  { serviceExit: 1, code: "RMI_SERVICE_MANAGER" },
  { libc: "glibc 2.27", code: "RMI_RUNTIME_COMPATIBILITY" },
]) test(`preflight ${options.code} fails before network/enrollment`, { skip: !posix }, () => {
  const f = fixture(options); try {
    const result = f.run(); assert.notEqual(result.status, 0); assert.ok(result.stderr.includes(options.code), result.stderr);
    assert.ok(!f.events().includes("download")); assert.ok(!result.stderr.includes("S".repeat(43)));
    assert.match(result.stderr, /Enrollment was not attempted/);
  } finally { f.cleanup(); }
});

for (const options of [
  { curlExit: 60, code: "RMI_TLS_CERTIFICATE" },
  { curlExit: 23, code: "RMI_DOWNLOAD_WRITE" },
  { curlExit: 28, code: "RMI_DOWNLOAD" },
  { curlExit: 48, code: "RMI_CURL_VERSION" },
  { invalidHash: true, code: "RMI_CHECKSUM_MISMATCH" },
  { corruptGzip: true, code: "RMI_DECOMPRESS" },
  { gzipExit: 1, code: "RMI_DECOMPRESS" },
  { tarExit: 2, code: "RMI_EXTRACT" },
  { nodeExit: 126, code: "RMI_RUNTIME_COMPATIBILITY" },
]) test(`bootstrap ${options.code} is actionable and never reaches enrollment`, { skip: !posix }, () => {
  const f = fixture(options); try {
    const result = f.run("check_bootstrap_tools; prepare_private_runtime; echo MUST_NOT_REDEEM_CODE");
    assert.notEqual(result.status, 0); assert.ok(result.stderr.includes(options.code), result.stderr);
    assert.ok(!result.stdout.includes("MUST_NOT_REDEEM_CODE")); assert.match(result.stderr, /Enrollment was not attempted/);
    assert.ok(!result.stderr.includes("S".repeat(43)));
    if (options.invalidHash) assert.deepEqual(readFileSync(f.env.RUNTIME_ARCHIVE), readFileSync(f.env.TEST_ARCHIVE));
  } finally { f.cleanup(); }
});

test("service and bootstrap checks precede enrollment; existing refresh precedes download-only dependencies", () => {
  assert.ok(shell.indexOf("\ncheck_service_prerequisites\n") < shell.indexOf("refresh_existing()"));
  assert.ok(shell.indexOf("then refresh_existing; exit") < shell.indexOf("\ncheck_bootstrap_tools\n"));
  assert.ok(shell.indexOf("\nprepare_private_runtime\n") < shell.indexOf('ENROLLMENT_ATTEMPTED=1\nstep'));
  assert.ok(shell.includes("gzip -dc") && shell.includes('tar -xf "$TMP/node-runtime.tar"'));
  assert.ok(shell.includes("--connect-timeout 15 --max-time 120 --retry 0"));
  assert.ok(!shell.includes("| awk"));
});

test("Windows runtime uses framework ZIP extraction and phase errors, not Expand-Archive or secret-bearing command locations", () => {
  const windows = renderPowerShellInstaller("https://installer.example.test");
  assert.ok(windows.includes("[IO.Compression.ZipFile]::ExtractToDirectory"));
  assert.ok(!windows.includes("Expand-Archive") && !windows.includes("PositionMessage"));
  assert.ok(windows.includes("[RMI_CHECKSUM_MISMATCH]") && windows.includes("[RMI_EXTRACT]"));
  assert.ok(windows.indexOf("Get-FileHash -LiteralPath $NodeArchivePath") < windows.indexOf("[IO.Compression.ZipFile]::ExtractToDirectory"));
});

test("Windows framework ZIP extraction succeeds using the emitted extractor without the Archive cmdlet", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "runmesh-zip-preflight-"));
  try {
    mkdirSync(join(root, "input")); writeFileSync(join(root, "input", "fixture.txt"), "verified-fixture");
    const windows = renderPowerShellInstaller("https://installer.example.test");
    const from = windows.indexOf("  $NodeExtract = Join-Path $TempRoot 'node-runtime'");
    const to = windows.indexOf("  $NodeHome =", from); assert.ok(from > 0 && to > from);
    const script = "$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n$TempRoot=$args[0]\n$NodeArchivePath=Join-Path $TempRoot 'fixture.zip'\n[IO.Compression.ZipFile]::CreateFromDirectory((Join-Path $TempRoot 'input'),$NodeArchivePath)\n" + windows.slice(from, to) + "\nif ((Get-Content -LiteralPath (Join-Path $NodeExtract 'fixture.txt')) -ne 'verified-fixture') { throw 'ZIP fixture mismatch' }\n";
    const path = join(root, "test.ps1"); writeFileSync(path, script);
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const result = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, root], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
