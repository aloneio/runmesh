import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the generated PowerShell downloader only, never installation,
// credential enrollment, or service mutation. The HTTP loopback fixture
// replaces HTTPS and reduces the production deadline/byte cap for the test.
const compiled = buildSync({ entryPoints: [fileURLToPath(new URL("../apps/worker/src/installer.ts", import.meta.url))], platform: "node", format: "cjs", bundle: true, write: false }).outputFiles[0].text;
const loaded = { exports: {} };
new Function("module", "exports", compiled)(loaded, loaded.exports);
const rendered = loaded.exports.renderPowerShellInstaller("https://installer.example.test");
const start = rendered.indexOf("  $HttpHandler = [Net.Http.HttpClientHandler]::new()");
const end = rendered.indexOf("  $VerifyLog =", start);
assert.ok(start >= 0 && end > start);
const downloader = rendered.slice(start, end)
  .replace("$HttpHandler.AllowAutoRedirect = $false", "$HttpHandler.AllowAutoRedirect = $false\n  $HttpHandler.UseProxy = $false")
  .replaceAll("-ne 'https'", "-ne 'http'")
  .replaceAll("60000", "1500")
  .replaceAll("8388608", "1024");

async function fixture(handler, { cancelAfter = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "runmesh-download-"));
  const sockets = new Set();
  const server = createServer(handler);
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const script = join(root, "download.ps1");
  await writeFile(script, `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
function Write-Step([string]$Message) {}
$TempRoot = $env:RUNMESH_DOWNLOAD_ROOT
$ReleaseBase = $env:RUNMESH_DOWNLOAD_ORIGIN
$AllowedReleaseOrigins = @($ReleaseBase)
$ArtifactName = 'runner.tgz'
$HttpClient = $null
$HttpHandler = $null
try {
${cancelAfter ? downloader : downloader.replace("$DownloadCancellation.CancelAfter(1500)", "# Deliberately emulate an operation which ignores cancellation.")}
  [Console]::WriteLine('DOWNLOAD_OK')
} catch {
  [Console]::WriteLine('DOWNLOAD_FAILED: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $HttpClient) { $HttpClient.Dispose() }
  if ($null -ne $HttpHandler) { $HttpHandler.Dispose() }
}
`);
  try {
    const child = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      windowsHide: true, env: { ...process.env, RUNMESH_DOWNLOAD_ROOT: root, RUNMESH_DOWNLOAD_ORIGIN: origin },
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
    assert.equal(timedOut, false, "downloader exceeded its body deadline");
    return { code, stdout, stderr, manifest: await readFile(join(root, "manifest.json")).catch(() => null) };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    // On Windows this also checks that failure paths closed the output file.
    await rm(root, { recursive: true, force: true });
  }
}

const options = { skip: process.platform !== "win32" };
test("PowerShell release downloader completes bounded assets", options, async () => {
  const result = await fixture((_request, response) => response.end("verified fixture"));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /DOWNLOAD_OK/);
  assert.equal(result.manifest.toString(), "verified fixture");
});

for (const cancelAfter of [true, false]) test(`PowerShell release body deadline closes a stalled response (cancellation ${cancelAfter})`, options, async () => {
  const result = await fixture((_request, response) => {
    response.writeHead(200, { "content-length": "2" });
    response.write("a");
  }, { cancelAfter });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /DOWNLOAD_FAILED/);
  assert.doesNotMatch(result.stdout, /DOWNLOAD_OK/);
});

for (const announced of [true, false]) test(`PowerShell release body cap rejects oversized ${announced ? "announced" : "streamed"} assets`, options, async () => {
  const result = await fixture((_request, response) => {
    response.writeHead(200, announced ? { "content-length": "1025" } : {});
    response.write(Buffer.alloc(1025));
    response.end();
  });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Release asset exceeds the fixed size limit/);
  assert.ok(result.manifest === null || result.manifest.length <= 1024);
});
