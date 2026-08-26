import { createMcpHandler } from "agents/mcp/server";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION } from "@remote-coding-runtime/protocol";
import { createCodingMcpServer, type McpAuth } from "./mcp/server.js";
import { RegistryDO, type McpClientRecord, type RunnerPublicInfo, type RunnerRecord, type VerifiedMcpClient } from "./registry.js";
import { RunnerDO, type WorkerEnv } from "./runner-do.js";
import type { CodingScope } from "./registry.js";
import {
  ADMIN_SESSION_TTL_MS,
  SETUP_CSRF_TTL_MS,
  bearerToken,
  constantTimeEqual,
  generateRunnerToken,
  internalHeaders,
  isSafeIdentifier,
  passwordVerifier,
  randomBase64Url,
  runnerTokenVerifier,
  sha256Hex,
  verifyInternalRequest,
  verifyPassword,
} from "./security.js";

export { RegistryDO, RunnerDO };

const MAX_ADMIN_BODY_BYTES = 16_384;
const ADMIN_SESSION_COOKIE = "__Host-rcr_admin_session";
const ADMIN_CSRF_COOKIE = "__Host-rcr_admin_csrf";
const SETUP_CSRF_COOKIE = "__Host-rcr_setup_csrf";
const LOGIN_CSRF_COOKIE = "__Host-rcr_login_csrf";
const MCP_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const CURRENT_RUNNER_PACKAGE_NAME = "@remote-coding-runtime/runner";
const CURRENT_RUNNER_PACKAGE_VERSION = "0.1.0";
const EXACT_STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;
const NPM_PACKAGE_SPEC_RE = /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+)$/;

export interface RunnerReleaseDescriptor {
  readonly channel: "stable";
  readonly current_version: string;
  readonly latest_version: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly package_spec: string;
  readonly artifacts: Readonly<Record<"linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "windows-x64", { readonly url: string; readonly sha256: string }>> | null;
  /** Backward-compatible source/checksum view for the configured package. */
  readonly artifact: { readonly source: string; readonly checksum?: { readonly algorithm: "sha256"; readonly value: string } } | null;
  readonly protocol: { readonly min_version: number; readonly max_version: number };
}

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;

async function handleRequest(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ok: true, service: "runmesh-agent-control-plane" });
  if (url.pathname === "/assets/logo.png" || url.pathname === "/assets/favicon.png") return asset(request, env);
  if (url.pathname === "/runner/install.sh") return runnerInstallScript(request, url);
  if (url.pathname === "/runner/install.ps1") return runnerInstallPowerShell(request, url);
  if (url.pathname === "/runner/releases/latest" || url.pathname === "/runner/releases/stable") return runnerRelease(request, env);
  if (isMcpPath(url.pathname)) return handleMcpSecret(request, env, url);
  if (url.pathname === "/mcp") return notFound();
  if (url.pathname.startsWith("/internal/runners/")) return forwardRunnerRpc(request, env, url);
  if (url.pathname === "/runner/enroll") return handleRunnerEnrollment(request, env);
  if (url.pathname.startsWith("/admin/runners")) {
    return isRunnerAdminRequest(request, env) ? handleRunnerAdmin(request, env, url) : handleBrowserAdmin(request, env, url);
  }
  if (url.pathname === "/" || url.pathname === "/setup" || url.pathname === "/login") return handleLanding(request, env, url);
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleBrowserAdmin(request, env, url);
  if (url.pathname === "/runner/connect") {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const runnerId = url.searchParams.get("runner_id");
    if (runnerId === null || !isSafeIdentifier(runnerId)) return new Response("invalid runner_id", { status: 400 });
    const target = new URL(request.url); target.pathname = `/runner/${encodeURIComponent(runnerId)}`; target.search = "";
    return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request(target, request));
  }
  return notFound();
}

async function asset(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") { await discardBody(request); return methodNotAllowed("GET, HEAD"); }
  if (env.ASSETS === undefined) return notFound();
  return env.ASSETS.fetch(request);
}

export interface RunnerReleaseEnvironment {
  readonly RUNNER_PACKAGE_SPEC?: string;
  readonly RUNNER_PACKAGE_NAME?: string;
  readonly RUNNER_PACKAGE_VERSION?: string;
  readonly RUNNER_ARTIFACT_SHA256?: string;
  /** Optional immutable per-platform release artifacts. */
  readonly RUNNER_ARTIFACTS_JSON?: string;
}

export function runnerReleaseDescriptor(env: RunnerReleaseEnvironment): RunnerReleaseDescriptor & { readonly distributable: boolean } {
  const configuredSpec = validRunnerPackageSpec(env.RUNNER_PACKAGE_SPEC);
  const configuredName = validRunnerPackageName(env.RUNNER_PACKAGE_NAME);
  const configuredVersion = validRunnerPackageVersion(env.RUNNER_PACKAGE_VERSION);
  const checksum = validSha256(env.RUNNER_ARTIFACT_SHA256);
  const artifacts = validRunnerArtifacts(env.RUNNER_ARTIFACTS_JSON);
  if (configuredSpec !== undefined) {
    const packageMatch = NPM_PACKAGE_SPEC_RE.exec(configuredSpec);
    const packageName = packageMatch?.[1] ?? configuredName;
    const packageVersion = packageMatch?.[2] ?? configuredVersion;
    if (packageName !== undefined && packageVersion !== undefined) {
      return {
        channel: "stable", package_name: packageName, package_version: packageVersion, package_spec: configuredSpec,
        current_version: CURRENT_RUNNER_PACKAGE_VERSION, latest_version: packageVersion,
        artifact: { source: configuredSpec, ...(checksum === undefined ? {} : { checksum: { algorithm: "sha256", value: checksum } }) },
        artifacts,
        distributable: true, protocol: { min_version: PROTOCOL_MIN_VERSION, max_version: PROTOCOL_CURRENT_VERSION },
      };
    }
  }
  return {
    channel: "stable", package_name: configuredName ?? CURRENT_RUNNER_PACKAGE_NAME,
    package_version: configuredVersion ?? CURRENT_RUNNER_PACKAGE_VERSION, package_spec: "", current_version: CURRENT_RUNNER_PACKAGE_VERSION, latest_version: CURRENT_RUNNER_PACKAGE_VERSION, artifact: null, artifacts: null,
    distributable: false, protocol: { min_version: PROTOCOL_MIN_VERSION, max_version: PROTOCOL_CURRENT_VERSION },
  };
}
function validRunnerPackageName(value: string | undefined): string | undefined {
  return value !== undefined && /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value) ? value : undefined;
}
function validRunnerPackageVersion(value: string | undefined): string | undefined { return value !== undefined && EXACT_STABLE_VERSION_RE.test(value) ? value : undefined; }
function validSha256(value: string | undefined): string | undefined { return value !== undefined && /^[a-f0-9]{64}$/.test(value) ? value : undefined; }
function validRunnerArtifacts(value: string | undefined): RunnerReleaseDescriptor["artifacts"] {
  if (value === undefined || value.length > 16_384) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const output: Record<string, { url: string; sha256: string }> = {};
    for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"] as const) {
      const item = (parsed as Record<string, unknown>)[platform];
      if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      let url: URL;
      try { url = new URL(typeof record.url === "string" ? record.url : ""); } catch { return null; }
      if (typeof record.url !== "string" || record.url.length > 2_048 || url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.hostname.endsWith("github.com") || /(?:^|\/)(?:latest|main|master)(?:\/|\.|$)/i.test(url.pathname) || typeof record.sha256 !== "string" || validSha256(record.sha256) === undefined) return null;
      output[platform] = { url: url.toString(), sha256: record.sha256 };
    }
    return output as RunnerReleaseDescriptor["artifacts"];
  } catch { return null; }
}
function validRunnerPackageSpec(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 2_048 || /\s/.test(value)) return undefined;
  const packageMatch = NPM_PACKAGE_SPEC_RE.exec(value);
  if (packageMatch !== null) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && !url.hostname.endsWith("github.com") && !/(?:^|\/)(?:latest|main|master)(?:\/|\.|$)/i.test(url.pathname) && url.pathname.endsWith(".tgz") ? url.toString() : undefined;
  } catch { return undefined; }
}
function runnerRelease(request: Request, env: WorkerEnv): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  return Response.json(runnerReleaseDescriptor(env), { headers: publicInstallerHeaders("application/json; charset=utf-8") });
}
function runnerInstallScript(request: Request, url: URL): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const origin = shellSingleQuoted(url.origin);
  const content = `#!/usr/bin/env sh
# Public bootstrap only: enrollment codes are accepted as the first command argument.
set -eu

SERVER_ORIGIN='${origin}'
usage() { printf '%s\\n' "usage: curl -fsSL $SERVER_ORIGIN/runner/install.sh | sh -s -- <one-time-enrollment-code> [--re-enroll]" >&2; }
die() { printf '%s\\n' "error: $*" >&2; exit 1; }

CODE=\${1:-}
REENROLL=0
if [ "\${2:-}" = "--re-enroll" ]; then REENROLL=1; fi
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || { [ "$#" -eq 2 ] && [ "\${2:-}" != "--re-enroll" ]; }; then usage; exit 2; fi
case "$CODE" in *[!A-Za-z0-9_-]*|'') die "a one-time enrollment code must be the first command argument";; esac
if [ "\${#CODE}" -lt 20 ] || [ "\${#CODE}" -gt 256 ]; then die "a one-time enrollment code must be the first command argument"; fi

case "$(uname -s)" in
  Linux) PROFILE="/etc/remote-coding-runtime/profile.json"; MANIFEST="/etc/systemd/system/remote-coding-runner.service"; NPM_PREFIX="/opt/remote-coding-runtime";;
  Darwin) PROFILE="/Library/Application Support/RemoteCodingRunner/profile.json"; MANIFEST="/Library/LaunchDaemons/com.remote-coding.runner.plist"; NPM_PREFIX="/opt/remote-coding-runtime";;
  *) die "unsupported operating system; use the Windows PowerShell installer on Windows";;
esac
if [ "$REENROLL" -ne 1 ] && { [ -f "$PROFILE" ] || { [ -f "$MANIFEST" ] && grep -q 'remote-coding-runner-managed:' "$MANIFEST"; }; }; then
  die "existing managed runner profile or service detected; refuse destructive overwrite. Re-run with --re-enroll after reviewing the existing installation."
fi
if [ "$(id -u)" -ne 0 ]; then die "system Runner installation requires administrator/root privileges; rerun from an elevated root shell"; fi
command -v node >/dev/null 2>&1 || die "Node.js 20 or newer must already be installed"
command -v npm >/dev/null 2>&1 || die "npm must already be installed with Node.js 20 or newer"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
case "$NODE_MAJOR" in ''|*[!0-9]*) die "could not determine the installed Node.js version";; esac
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or newer must already be installed"
command -v curl >/dev/null 2>&1 || die "curl is required to retrieve the public release descriptor"
RELEASE="$(curl -fsSL --proto '=https' --tlsv1.2 "$SERVER_ORIGIN/runner/releases/latest")" || die "could not retrieve the runner release descriptor"
PACKAGE_SPEC="$(printf '%s' "$RELEASE" | node -e 'let x="";process.stdin.on("data",d=>x+=d).on("end",()=>{try{const r=JSON.parse(x),npm=/^((?:@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*)@\\d+\\.\\d+\\.\\d+$/,tar=/^https:\/\/[^?#]+\\.tgz$/;if(r.distributable!==true||typeof r.package_name!=="string"||typeof r.package_version!=="string"||typeof r.package_spec!=="string"||!/^\\d+\\.\\d+\\.\\d+$/.test(r.package_version)||!(npm.test(r.package_spec)||tar.test(r.package_spec))||!r.protocol||!Number.isInteger(r.protocol.min_version)||!Number.isInteger(r.protocol.max_version)||r.protocol.min_version<1||r.protocol.min_version>r.protocol.max_version)process.exit(1);process.stdout.write(r.package_spec)}catch{process.exit(1)}})')" || die "the operator has not configured a distributable stable runner package spec at /runner/releases/latest"
mkdir -p "$NPM_PREFIX"
npm install --global --prefix "$NPM_PREFIX" "$PACKAGE_SPEC"
RUNNER="$NPM_PREFIX/bin/coding-runner"
[ -x "$RUNNER" ] || die "npm did not install coding-runner into the machine prefix"
"$RUNNER" enroll --server "$SERVER_ORIGIN/runner/enroll" --code "$CODE"
# coding-runner enroll --server is invoked above through the absolute machine executable.
"$RUNNER" install --executable-path "$RUNNER"
printf '%s\\n' 'Runner system service installed and activated.'
`;
  return new Response(content, { headers: publicInstallerHeaders("text/x-shellscript; charset=utf-8") });
}
function runnerInstallPowerShell(request: Request, url: URL): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const origin = powerShellSingleQuoted(url.origin);
  const content = `# Public bootstrap only: enrollment codes are accepted as the first command argument.
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidatePattern('^[A-Za-z0-9_-]{20,256}$')]
  [string]$EnrollmentCode,
  [switch]$ReEnroll
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ServerOrigin = '${origin}'
$ProfilePath = Join-Path $env:ProgramData 'RemoteCodingRunner\\profile.json'
$ManifestPath = Join-Path $env:ProgramData 'RemoteCodingRunner\\coding-runner-task.xml'
$NpmPrefix = Join-Path $env:ProgramFiles 'RemoteCodingRunner'
if (-not $ReEnroll -and ((Test-Path -LiteralPath $ProfilePath) -or ((Test-Path -LiteralPath $ManifestPath) -and (Select-String -LiteralPath $ManifestPath -SimpleMatch 'remote-coding-runner-managed:' -Quiet)))) {
  throw 'existing managed runner profile or service detected; refuse destructive overwrite. Re-run with -ReEnroll after reviewing the existing installation.'
}
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'system Runner installation requires an elevated Administrator PowerShell session.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or newer and npm must already be installed.' }
$NodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 20) { throw 'Node.js 20 or newer must already be installed.' }
$Release = Invoke-RestMethod -Uri "$ServerOrigin/runner/releases/latest" -Method Get
if ($Release.distributable -ne $true -or $Release.package_version -notmatch '^\\d+\\.\\d+\\.\\d+$' -or ($Release.package_spec -notmatch '^((?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*)@\\d+\\.\\d+\\.\\d+$' -and $Release.package_spec -notmatch '^https://[^?#]+\\.tgz$') -or $Release.protocol.min_version -lt 1 -or $Release.protocol.min_version -gt $Release.protocol.max_version) {
  throw 'The operator has not configured a distributable stable runner package spec at /runner/releases/latest.'
}
$NpmPrefix = Join-Path $env:ProgramFiles 'RemoteCodingRunner'
New-Item -ItemType Directory -Force -Path $NpmPrefix | Out-Null
& npm install --global --prefix $NpmPrefix $Release.package_spec
$Runner = Join-Path $NpmPrefix 'bin\\coding-runner.cmd'
if (-not (Test-Path -LiteralPath $Runner)) { throw 'npm did not install coding-runner into the machine prefix.' }
& $Runner enroll --server "$ServerOrigin/runner/enroll" --code $EnrollmentCode
# coding-runner enroll --server is invoked above through the absolute machine executable.
& $Runner install --executable-path $Runner
Write-Output 'Runner system Scheduled Task installed and activated.'
`;
  return new Response(content, { headers: publicInstallerHeaders("text/plain; charset=utf-8") });
}
function publicInstallerHeaders(contentType: string): Headers {
  return new Headers({ "content-type": contentType, "cache-control": "public, max-age=300", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "permissions-policy": "geolocation=(), microphone=(), camera=()" });
}
function shellSingleQuoted(value: string): string { return value.replaceAll("'", "'\\\"'\\\"'"); }
function powerShellSingleQuoted(value: string): string { return value.replaceAll("'", "''"); }

async function handleRunnerEnrollment(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST") { await discardBody(request); return methodNotAllowed("POST"); }
  const input = await readEnrollmentBody(request);
  const code = typeof input?.enrollment_code === "string" && /^[A-Za-z0-9_-]{43}$/.test(input.enrollment_code) ? input.enrollment_code : undefined;
  const publicInfo = runnerPublicInfo(input?.runner_public_info);
  if (code === undefined || publicInfo === undefined || env.RUNNER_TOKEN_PEPPER === undefined) return enrollmentError();
  const token = generateRunnerToken();
  const response = await registryPost(env, "/enrollments/redeem", {
    verifier: await sha256Hex(code), token_verifier: await runnerTokenVerifier(token, env.RUNNER_TOKEN_PEPPER), runner_public_info: publicInfo,
  });
  const body = response.ok ? record(await json(response)) : undefined;
  const runnerId = body?.runner_id;
  if (typeof runnerId !== "string") return enrollmentError();
  const url = new URL(request.url); url.pathname = "/runner/connect"; url.search = "";
  return Response.json({ runner_id: runnerId, server_url: url.toString(), token }, { headers: credentialHeaders("application/json; charset=utf-8") });
}
function runnerPublicInfo(value: unknown): RunnerPublicInfo | undefined {
  const item = record(value);
  if (item === undefined || !safeDisplayText(item.platform, 128) || !safeDisplayText(item.architecture, 128) || !safeDisplayText(item.hostname, 256) || !safeDisplayText(item.runner_version, 256) || typeof item.protocol_version !== "number") return undefined;
  const info: RunnerPublicInfo = { platform: item.platform, architecture: item.architecture, hostname: item.hostname, runner_version: item.runner_version, protocol_version: item.protocol_version };
  return Number.isSafeInteger(info.protocol_version) && info.protocol_version > 0 && info.protocol_version <= 1_000 ? info : undefined;
}
function safeDisplayText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value);
}
async function readEnrollmentBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const length = request.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4_096)) { await discardBody(request); return undefined; }
  const body = typeof request.body === "undefined" ? undefined : await request.text();
  if (body !== undefined && new TextEncoder().encode(body).byteLength > 4_096) return undefined;
  try { return record(body === undefined ? undefined : JSON.parse(body) as unknown); } catch { return undefined; }
}
function enrollmentError(): Response { return new Response("invalid enrollment", { status: 401, headers: credentialHeaders("text/plain; charset=utf-8") }); }

/** The URL segment is the only MCP credential. Authorization headers are ignored. */
async function handleMcpSecret(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  const secret = parts[0];
  if (secret === undefined || !MCP_SECRET_RE.test(secret)) return notFound();
  const verified = await verifyMcpClient(env, await sha256Hex(secret));
  if (verified === undefined) return notFound();
  // createMcpHandler requires an exact /mcp route. Do not consume request.body
  // before cloning it: the SDK must receive the original JSON-RPC stream.
  const rewritten = new URL(request.url);
  rewritten.pathname = "/mcp";
  rewritten.search = "";
  const auth: McpAuth = {
    // AuthInfo needs an opaque token but no component needs the raw URL secret.
    token: verified.client_id,
    clientId: verified.client_id,
    scopes: [...verified.scopes],
    extra: { client_label: verified.label, secret_version: verified.secret_version },
  };
  const handler = createMcpHandler(
    () => createCodingMcpServer(env, auth),
    {
      route: "/mcp",
      // Safe identity only. The raw secret is intentionally absent.
      authContext: { props: { client_id: verified.client_id, client_label: verified.label, scopes: [...verified.scopes], secret_version: verified.secret_version } },
      legacy: "stateless",
    },
  );
  return handler.fetch(new Request(rewritten, request), { authInfo: auth });
}

function isMcpPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[1] === "mcp";
}

async function handleLanding(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const initialized = await registryGet(env, "/auth/status").then((response) => response.ok ? response.json() as Promise<{ initialized?: unknown }> : undefined);
  if (initialized?.initialized !== true) {
    if (url.pathname !== "/" && url.pathname !== "/setup") { if (request.method !== "GET") await discardBody(request); return notFound(); }
    if (request.method === "GET") return setupPage();
    if (request.method === "POST") return submitSetup(request, env);
    await discardBody(request);
    return methodNotAllowed("GET, POST");
  }
  if (url.pathname === "/setup") {
    if (request.method !== "GET") await discardBody(request);
    return new Response("already initialized", { status: 409, headers: htmlHeaders() });
  }
  if (request.method === "GET") return loginPage();
  if (request.method === "POST") return submitLogin(request, env);
  await discardBody(request);
  return methodNotAllowed("GET, POST");
}

async function submitSetup(request: Request, env: WorkerEnv): Promise<Response> {
  const form = await formData(request);
  if (form === undefined) return adminError(400, "Invalid setup request.");
  if (!await verifyPreAuthCsrf(request, form, SETUP_CSRF_COOKIE)) return adminError(403, "Setup request was rejected.");
  const throttle = await authThrottleCheck(env, "setup");
  if (throttle === undefined) return adminError(503, "Setup could not be completed. Try again.");
  if (!throttle.allowed) return throttleError(throttle.retry_after_ms);
  const password = form.get("password"); const confirmation = form.get("confirm_password");
  if (typeof password !== "string" || typeof confirmation !== "string" || !validPassword(password) || password !== confirmation) return adminError(400, "Passwords must match and be at least 12 characters.");
  const verifier = await passwordVerifier(password);
  const response = await registryPost(env, "/auth/setup", { password_verifier: verifier });
  if (response.status === 204) {
    await authThrottleRecord(env, "setup", true);
    return redirect("/", [clearCookie(SETUP_CSRF_COOKIE)]);
  }
  await authThrottleRecord(env, "setup", false);
  if (response.status === 409) return adminError(409, "This instance is already initialized.", [clearCookie(SETUP_CSRF_COOKIE)]);
  return adminError(503, "Setup could not be completed. Try again.");
}

async function submitLogin(request: Request, env: WorkerEnv): Promise<Response> {
  const form = await formData(request);
  if (form === undefined) return adminError(400, "Invalid login request.");
  if (!await verifyPreAuthCsrf(request, form, LOGIN_CSRF_COOKIE)) return adminError(403, "Login request was rejected.");
  const throttle = await authThrottleCheck(env, "login");
  if (throttle === undefined) return adminError(503, "Login could not be completed. Try again.");
  if (!throttle.allowed) return throttleError(throttle.retry_after_ms);
  const password = form.get("password");
  if (typeof password !== "string") return adminError(403, "Invalid administrator password.", [clearCookie(LOGIN_CSRF_COOKIE)]);
  const settings = await registryGet(env, "/auth/settings");
  const body = settings.ok ? await json(settings) : undefined;
  const verifier = record(body)?.password_verifier;
  const valid = typeof verifier === "string" && await verifyPassword(password, verifier);
  await authThrottleRecord(env, "login", valid);
  if (!valid) return adminError(403, "Invalid administrator password.", [clearCookie(LOGIN_CSRF_COOKIE)]);
  const rawSession = randomBase64Url(); const rawCsrf = randomBase64Url();
  const sessionResponse = await registryPost(env, "/auth/sessions", {
    session_hash: await sha256Hex(rawSession), csrf_hash: await sha256Hex(rawCsrf), expires_at_ms: Date.now() + ADMIN_SESSION_TTL_MS,
  });
  if (!sessionResponse.ok) return adminError(503, "Login could not be completed. Try again.");
  return redirect("/admin", [sessionCookie(rawSession), csrfCookie(rawCsrf), clearCookie(LOGIN_CSRF_COOKIE)]);
}

async function handleBrowserAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const session = await adminSession(request, env);
  if (session === undefined) { if (request.method !== "GET") await discardBody(request); return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]); }
  if (request.method === "GET" && ["/admin", "/admin/runners", "/admin/clients", "/admin/settings"].includes(url.pathname)) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const data = await loadDashboardData(env);
    return html(adminPage(url.pathname, data, csrf));
  }
  const runnerDetail = /^\/admin\/runners\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(url.pathname);
  if (request.method === "GET" && runnerDetail !== null) {
    const csrf = cookieValue(request, ADMIN_CSRF_COOKIE);
    if (csrf === undefined || !constantTimeEqual(await sha256Hex(csrf), session.csrf_hash)) return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
    const runnerId = runnerDetail[1] as string;
    const [runnerResponse, workspaceResponse, jobsResponse, environment, releaseResponse] = await Promise.all([
      registryGet(env, `/runners/${encodeURIComponent(runnerId)}`),
      registryGet(env, `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces`),
      registryGet(env, `/runners/${encodeURIComponent(runnerId)}/jobs?status=running&limit=20`),
      runnerEnvironment(env, runnerId),
      Promise.resolve(runnerReleaseDescriptor(env)),
    ]);
    const runner = runnerResponse.ok ? record(await json(runnerResponse)) : undefined;
    const workspaces = workspaceResponse.ok ? arrayField(record(await json(workspaceResponse))?.workspaces) : [];
    const jobs = jobsResponse.ok ? arrayField(record(await json(jobsResponse))?.jobs) : [];
    return runner === undefined ? adminError(404, "Runner was not found.") : html(runnerDetailPage(runner, workspaces, jobs, environment, csrf, releaseResponse));
  }
  if (request.method !== "POST") { await discardBody(request); return methodNotAllowed("GET, POST"); }
  const form = await formData(request);
  if (form === undefined || !await verifyAdminPost(request, form, session)) return adminError(403, "Administrative request was rejected.");
  if (url.pathname === "/admin/logout") {
    await registryPost(env, "/auth/sessions/logout", { session_hash: session.hash });
    return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
  }
  if (url.pathname === "/admin/password") return changePassword(env, form);
  if (url.pathname === "/admin/clients") return createClient(env, form, request.url);
  if (url.pathname === "/admin/runners") return createBrowserRunner(env, form, request.url);
  const runnerMatch = /^\/admin\/runners\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(rename|rotate|revoke|delete|enrollment|permissions|version-policy|emergency-lock|workspace-create|workspace-update|workspace-delete)$/.exec(url.pathname);
  if (runnerMatch !== null) return handleBrowserRunnerAction(env, form, request.url, runnerMatch[1] as string, runnerMatch[2] as "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete");
  const clientMatch = /^\/admin\/clients\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(rename|rotate|revoke|reset-runner)$/.exec(url.pathname);
  if (clientMatch === null) return notFound();
  const clientId = clientMatch[1] as string; const action = clientMatch[2] as "rename" | "rotate" | "revoke" | "reset-runner";
  if (action === "reset-runner") {
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/active-runner/reset`, {});
    return response.ok ? redirect("/admin/clients") : adminError(response.status === 404 ? 404 : 400, "Runner selection could not be reset.");
  }
  if (action === "rename") {
    const label = form.get("label");
    if (typeof label !== "string" || !validLabel(label)) return adminError(400, "Client name is invalid.");
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/rename`, { label });
    return response.ok ? redirect("/admin") : adminError(response.status === 404 ? 404 : 400, "Client update failed.");
  }
  if (action === "revoke") {
    const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/revoke`, {});
    return response.ok ? redirect("/admin") : adminError(response.status === 404 ? 404 : 400, "Client revoke failed.");
  }
  const secret = randomBase64Url();
  const response = await registryPost(env, `/auth/clients/${encodeURIComponent(clientId)}/rotate`, { secret_verifier: await sha256Hex(secret), secret_prefix: secret.slice(0, 8) });
  if (!response.ok) return adminError(response.status === 404 ? 404 : 400, "Client rotation failed.");
  return html(secretCreatedPage("MCP client rotated", secretUrl(request.url, secret)));
}

async function changePassword(env: WorkerEnv, form: FormData): Promise<Response> {
  const current = form.get("current_password"); const password = form.get("password"); const confirmation = form.get("confirm_password");
  if (typeof current !== "string" || typeof password !== "string" || typeof confirmation !== "string" || !validPassword(password) || password !== confirmation) return adminError(400, "Password change is invalid.");
  const settings = await registryGet(env, "/auth/settings"); const verifier = record(settings.ok ? await json(settings) : undefined)?.password_verifier;
  if (typeof verifier !== "string" || !await verifyPassword(current, verifier)) return adminError(403, "Current administrator password is invalid.");
  const response = await registryPost(env, "/auth/password", { password_verifier: await passwordVerifier(password) });
  if (!response.ok) return adminError(503, "Password change could not be completed.");
  return redirect("/", [clearCookie(ADMIN_SESSION_COOKIE), clearCookie(ADMIN_CSRF_COOKIE)]);
}

async function createBrowserRunner(env: WorkerEnv, form: FormData, baseUrl: string): Promise<Response> {
  const submittedId = form.get("runner_id"); const displayName = form.get("display_name");
  const runnerId = typeof submittedId === "string" && submittedId.trim().length > 0 ? submittedId : `runner-${crypto.randomUUID().replaceAll("-", "")}`;
  if (!isSafeIdentifier(runnerId) || typeof displayName !== "string" || !validLabel(displayName)) return adminError(400, "Runner identifier or display name is invalid.");
  const response = await runnerRegistryRequest(env, runnerId, "/add", "POST", JSON.stringify({ display_name: displayName }));
  if (!response.ok) return adminError(response.status === 409 ? 409 : 400, "Runner could not be added.");
  return runnerEnrollmentPage(baseUrl, runnerId, await createEnrollmentCode(env, runnerId), String(form.get("csrf_token") ?? ""));
}
async function handleBrowserRunnerAction(env: WorkerEnv, form: FormData, baseUrl: string, runnerId: string, action: "rename" | "rotate" | "revoke" | "delete" | "enrollment" | "permissions" | "version-policy" | "emergency-lock" | "workspace-create" | "workspace-update" | "workspace-delete"): Promise<Response> {
  if (action === "version-policy") {
    const updateChannel = form.get("update_channel"); const desired = form.get("desired_runner_version");
    if ((updateChannel !== "stable" && updateChannel !== "pinned") || (typeof desired !== "string" && desired !== null)) return adminError(400, "Runner update policy is invalid.");
    const latest = runnerReleaseDescriptor(env).package_version;
    const payload = { update_channel: updateChannel, ...(updateChannel === "pinned" && typeof desired === "string" && desired.length > 0 ? { desired_runner_version: desired } : {}), ...(updateChannel === "stable" ? { latest_runner_version: latest } : {}) };
    if (updateChannel === "pinned" && !(typeof desired === "string" && validRunnerVersion(desired))) return adminError(400, "Pinned Runner version must be an exact version.");
    const response = await registryPost(env, `/auth/runners/${encodeURIComponent(runnerId)}/version-policy`, payload);
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(runnerId)}`) : adminError(response.status === 404 ? 404 : 400, "Runner update policy could not be updated.");
  }
  if (action === "permissions") {
    const permissions = permissionsFromForm(form);
    if (permissions === undefined) return adminError(400, "Runner permissions are invalid.");
    const response = await registryPost(env, `/auth/runners/${encodeURIComponent(runnerId)}/permissions`, { permissions });
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(runnerId)}`) : adminError(response.status === 404 ? 404 : 400, "Runner permission profile could not be updated.");
  }
  if (action === "emergency-lock") {
    const response = await registryPost(env, `/auth/runners/${encodeURIComponent(runnerId)}/emergency-lock`, {});
    return response.ok ? redirect(`/admin/runners/${encodeURIComponent(runnerId)}`) : adminError(response.status === 404 ? 404 : 400, "Emergency lock could not be applied.");
  }
  if (action.startsWith("workspace-")) return handleBrowserWorkspaceAction(env, form, runnerId, action as "workspace-create" | "workspace-update" | "workspace-delete");
  if (action === "rename") {
    const displayName = form.get("display_name");
    if (typeof displayName !== "string" || !validLabel(displayName)) return adminError(400, "Runner display name is invalid.");
    const response = await runnerRegistryRequest(env, runnerId, "/rename", "POST", JSON.stringify({ display_name: displayName }));
    return response.ok ? redirect("/admin") : adminError(response.status === 404 ? 404 : 400, "Runner rename failed.");
  }
  if (action === "delete") {
    const response = await runnerRegistryRequest(env, runnerId, "", "DELETE", "");
    if (!response.ok) return adminError(response.status === 404 ? 404 : 400, "Runner delete failed.");
    await closeRunnerSockets(env, runnerId);
    return redirect("/admin");
  }
  if (action === "revoke") {
    const response = await runnerRegistryRequest(env, runnerId, "/revoke", "POST", "{}");
    if (!response.ok) return adminError(response.status === 404 ? 404 : 400, "Runner revoke failed.");
    await closeRunnerSockets(env, runnerId);
    return redirect("/admin");
  }
  if (action === "rotate") {
    const response = await runnerRegistryRequest(env, runnerId, "/rotate", "POST", "{}");
    if (!response.ok) return adminError(response.status === 404 ? 404 : 400, "Runner credential rotation failed.");
    await closeRunnerSockets(env, runnerId);
    return runnerEnrollmentPage(baseUrl, runnerId, await createEnrollmentCode(env, runnerId), String(form.get("csrf_token") ?? ""), true);
  }
  return runnerEnrollmentPage(baseUrl, runnerId, await createEnrollmentCode(env, runnerId), String(form.get("csrf_token") ?? ""), true);
}
async function registryRequest(env: WorkerEnv, path: string, method: string, body: string): Promise<Response> {
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", method, path.split("?", 1)[0] ?? path, body);
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method, body, headers }));
}

async function handleBrowserWorkspaceAction(env: WorkerEnv, form: FormData, runnerId: string, action: "workspace-create" | "workspace-update" | "workspace-delete"): Promise<Response> {
  const returnToDetail = `/admin/runners/${encodeURIComponent(runnerId)}`;
  const workspaceId = form.get("workspace_id");
  if (typeof workspaceId !== "string" || !isSafeIdentifier(workspaceId)) return adminError(400, "Workspace identifier is invalid.");
  if (action === "workspace-delete") {
    const response = await registryRequest(env, `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces/${encodeURIComponent(workspaceId)}`, "DELETE", "");
    return response.ok ? redirect(returnToDetail) : adminError(response.status === 404 ? 404 : 400, "Workspace could not be deleted.");
  }
  const displayName = form.get("display_name"); const rootPath = form.get("root_path"); const permissions = permissionsFromForm(form);
  if (typeof displayName !== "string" || !validLabel(displayName) || typeof rootPath !== "string" || !isAbsolutePath(rootPath) || permissions === undefined) return adminError(400, "Workspace name, absolute root path, or permissions are invalid.");
  const enabled = form.get("enabled") === "true";
  const payload = { workspace_id: workspaceId, display_name: displayName, root_path: rootPath, enabled, permissions };
  const response = action === "workspace-create"
    ? await registryPost(env, `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces`, payload)
    : await registryRequest(env, `/auth/runners/${encodeURIComponent(runnerId)}/managed-workspaces/${encodeURIComponent(workspaceId)}`, "PUT", JSON.stringify(payload));
  return response.ok ? redirect(returnToDetail) : adminError(response.status === 404 ? 404 : 400, "Workspace could not be saved.");
}
function permissionsFromForm(form: FormData): { read: boolean; edit: boolean; shell: boolean; job_control: boolean } | undefined {
  const value = (name: string): boolean | undefined => { const entry = form.get(name); return entry === "true" ? true : entry === "false" ? false : undefined; };
  const read = value("read"); const edit = value("edit"); const shell = value("shell"); const jobControl = value("job_control");
  return read === undefined || edit === undefined || shell === undefined || jobControl === undefined ? undefined : { read, edit, shell, job_control: jobControl };
}
function isAbsolutePath(value: string): boolean { return value.length > 0 && value.length <= 4_096 && !value.includes("\0") && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)); }

async function createEnrollmentCode(env: WorkerEnv, runnerId: string): Promise<string | undefined> {
  const code = randomBase64Url();
  const response = await runnerRegistryRequest(env, runnerId, "/enrollments", "POST", JSON.stringify({ enrollment_id: randomBase64Url(), verifier: await sha256Hex(code) }));
  return response.ok ? code : undefined;
}

async function createClient(env: WorkerEnv, form: FormData, baseUrl: string): Promise<Response> {
  const label = form.get("label"); const scopes = selectedScopes(form);
  if (typeof label !== "string" || !validLabel(label) || scopes === undefined) return adminError(400, "Client name or scopes are invalid.");
  const secret = randomBase64Url();
  const clientId = `client-${crypto.randomUUID().replaceAll("-", "")}`;
  const response = await registryPost(env, "/auth/clients", {
    client_id: clientId, label, scopes, secret_verifier: await sha256Hex(secret), secret_prefix: secret.slice(0, 8),
  });
  if (!response.ok) return adminError(response.status === 409 ? 409 : 503, "Client could not be created.");
  return html(secretCreatedPage("MCP client created", secretUrl(baseUrl, secret)));
}

async function adminSession(request: Request, env: WorkerEnv): Promise<{ hash: string; csrf_hash: string } | undefined> {
  const raw = cookieValue(request, ADMIN_SESSION_COOKIE);
  if (raw === undefined || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
  const hash = await sha256Hex(raw);
  const response = await registryPost(env, "/auth/sessions/verify", { session_hash: hash });
  const csrfHash = record(response.ok ? await json(response) : undefined)?.csrf_hash;
  return typeof csrfHash === "string" && /^[0-9a-f]{64}$/.test(csrfHash) ? { hash, csrf_hash: csrfHash } : undefined;
}
async function verifyAdminPost(request: Request, form: FormData, session: { csrf_hash: string }): Promise<boolean> {
  if (!sameOrigin(request)) return false;
  const supplied = form.get("csrf_token"); const cookie = cookieValue(request, ADMIN_CSRF_COOKIE);
  return typeof supplied === "string" && typeof cookie === "string" && constantTimeEqual(supplied, cookie) && constantTimeEqual(await sha256Hex(supplied), session.csrf_hash);
}
async function verifyPreAuthCsrf(request: Request, form: FormData, name: string): Promise<boolean> {
  if (!sameOrigin(request)) return false;
  const supplied = form.get("csrf_token"); const cookie = cookieValue(request, name);
  return typeof supplied === "string" && typeof cookie === "string" && constantTimeEqual(supplied, cookie);
}
function sameOrigin(request: Request): boolean {
  const origin = new URL(request.url).origin;
  const candidate = request.headers.get("origin") ?? request.headers.get("referer");
  if (candidate === null) return true; // non-browser form clients still need SameSite + CSRF token.
  try { return new URL(candidate).origin === origin; } catch { return false; }
}

function setupPage(): Response { const csrf = randomBase64Url(); return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane setup</title></head><body><main><h1>Welcome to Runmesh</h1><p class="subtitle">Agent Control Plane</p><p>Create administrator password</p><form method="post" action="/setup"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Password <input type="password" name="password" autocomplete="new-password" required minlength="12"></label><label>Confirm password <input type="password" name="confirm_password" autocomplete="new-password" required minlength="12"></label><button>Initialize</button></form></main></body></html>`, [`${SETUP_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]); }
function loginPage(): Response { const csrf = randomBase64Url(); return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane login</title></head><body><main><h1>Runmesh</h1><p class="subtitle">Agent Control Plane</p><form method="post" action="/login"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Admin password <input type="password" name="password" autocomplete="current-password" required></label><button>Login</button></form></main></body></html>`, [`${LOGIN_CSRF_COOKIE}=${csrf}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(SETUP_CSRF_TTL_MS / 1_000)}`]); }
type AdminData = { readonly clients: readonly McpClientRecord[]; readonly runners: readonly RunnerRecord[]; readonly jobs: readonly Record<string, unknown>[]; readonly snapshot: Record<string, unknown> };
async function loadDashboardData(env: WorkerEnv): Promise<AdminData> {
  const [clientsResponse, runnersResponse, snapshotResponse] = await Promise.all([registryGet(env, "/auth/clients"), registryGet(env, "/dashboard"), registryGet(env, "/runners")]);
  const clients = clientsResponse.ok ? ((record(await json(clientsResponse))?.clients ?? []) as McpClientRecord[]) : [];
  const snapshotBody = snapshotResponse.ok ? record(await json(snapshotResponse)) : undefined;
  const runners = snapshotBody !== undefined && Array.isArray(snapshotBody.runners) ? snapshotBody.runners as RunnerRecord[] : runnersResponse.ok ? ((record(await json(runnersResponse))?.runners ?? []) as RunnerRecord[]) : [];
  const jobs = snapshotBody !== undefined && Array.isArray(snapshotBody.jobs) ? snapshotBody.jobs.filter(record) as Record<string, unknown>[] : [];
  return { clients, runners, jobs, snapshot: snapshotBody ?? {} };
}
async function runnerEnvironment(env: WorkerEnv, runnerId: string): Promise<Record<string, unknown> | undefined> {
  const response = await runnerRpc(env, runnerId, "env.info", {});
  const body = response.ok ? record(await json(response)) : undefined;
  const result = record(body?.result);
  return result;
}
async function runnerRpc(env: WorkerEnv, runnerId: string, method: string, params: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify({ method, params });
  const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/rpc", body);
  return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body }));
}
function adminPage(pathname: string, data: AdminData, csrf: string): string {
  const active = pathname === "/admin" ? "dashboard" : pathname.slice("/admin/".length);
  const nav = `<nav aria-label="Main navigation"><a class="${active === "dashboard" ? "active" : ""}" href="/admin">Dashboard</a><a class="${active === "runners" ? "active" : ""}" href="/admin/runners">Runners</a><a class="${active === "clients" ? "active" : ""}" href="/admin/clients">MCP Clients</a><a class="${active === "settings" ? "active" : ""}" href="/admin/settings">Settings</a></nav>`;
  const body = active === "runners" ? runnersPage(data, csrf) : active === "clients" ? clientsPage(data, csrf) : active === "settings" ? settingsPage(csrf) : overviewPage(data, csrf);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><link rel="preload" href="/assets/logo.png" as="image" type="image/png"><title>${escapeHtml(active[0]?.toUpperCase() ?? "Dashboard")} · Runmesh · Agent Control Plane</title>${adminStyles()}</head><body><div class="shell"><header class="topbar"><a class="brand" href="/admin"><img src="/assets/logo.png" alt="Runmesh · Agent Control Plane" class="brand-logo"><span>Runmesh</span></a><div class="top-actions"><a class="button secondary" href="/admin/runners#add-runner">Add Runner</a><a class="button" href="/admin/clients#add-client">Add MCP Client</a></div></header>${nav}<main>${body}</main></div>${adminScript()}</body></html>`;
}
function overviewPage(data: AdminData, csrf: string): string {
  const online = data.runners.filter((runner) => runner.state === "online").length;
  const activeJobs = data.jobs.filter((job) => ["queued", "running", "cancelling"].includes(String(job.status))).length;
  return `<section class="page-heading"><div><p class="eyebrow">Control plane</p><h1>Dashboard</h1><p class="lede">A concise view of connected runtimes, clients, and recent work.</p></div><button class="button secondary" type="button" data-refresh>Refresh</button></section><section class="metrics" aria-label="Summary"><div class="metric"><span>Active MCP clients</span><strong>${data.clients.filter((client) => client.revoked_at_ms === null).length}</strong></div><div class="metric"><span>Online / total runners</span><strong>${online} / ${data.runners.length}</strong></div><div class="metric"><span>Running jobs</span><strong>${activeJobs}</strong></div><div class="metric"><span>Recent jobs</span><strong>${data.jobs.length}</strong></div></section><div class="grid-two"><section class="panel"><div class="section-title"><h2>Recent runners</h2><a href="/admin/runners">View all</a></div>${runnerList(data.runners.slice(0, 5))}</section><section class="panel"><div class="section-title"><h2>Recent MCP clients</h2><a href="/admin/clients">View all</a></div>${clientList(data.clients.slice(0, 5))}</section></div><section class="panel"><div class="section-title"><h2>Recent jobs</h2><a href="/admin/runners">Runner activity</a></div>${jobTable(data.jobs.slice(0, 10))}</section><form class="hidden" method="post" action="/admin/logout"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"></form>`;
}
function runnersPage(data: AdminData, csrf: string): string {
  const table = data.runners.map((runner) => `<tr><td><a class="strong" href="/admin/runners/${encodeURIComponent(runner.runner_id)}">${escapeHtml(runner.display_name)}</a><small>${escapeHtml(runner.runner_id)}</small></td><td>${statusBadge(runner.state)}</td><td>${escapeHtml(safePlatform(runner))}</td><td>${runnerWorkspaceCount(runner)}</td><td>${runnerActiveJobs(runner)}</td><td>${escapeHtml(time(runner.last_heartbeat_ms))}</td><td class="actions"><a class="button small secondary" href="/admin/runners/${encodeURIComponent(runner.runner_id)}">View</a><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/rename"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input name="display_name" value="${escapeHtml(runner.display_name)}" aria-label="Rename ${escapeHtml(runner.display_name)}" maxlength="256"><button class="small secondary">Rename</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/rotate"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Rotate Credential</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/revoke"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small danger">Revoke</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/delete"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small danger">Delete</button></form><form method="post" action="/admin/runners/${encodeURIComponent(runner.runner_id)}/enrollment"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Install / Reinstall</button></form></td></tr>`).join("") || `<tr><td colspan="7" class="empty">No runners yet.</td></tr>`;
  return `<section class="page-heading"><div><p class="eyebrow">Infrastructure</p><h1>Runners</h1><p class="lede">Manage safe runner metadata and one-time enrollment.</p></div></section><section class="panel" id="add-runner"><div class="section-title"><h2>Add Runner</h2><span class="muted">Enrollment codes expire after 30 minutes.</span></div><form method="post" action="/admin/runners" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Display name<input name="display_name" maxlength="256" required autocomplete="off"></label><label>Safe runner ID <span class="muted">optional</span><input name="runner_id" maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" placeholder="generated-id"></label><button class="button">Create enrollment</button></form></section><section class="panel"><div class="table-wrap"><table><caption class="sr-only">Registered runners</caption><thead><tr><th>Display name</th><th>Status</th><th>Platform / architecture</th><th>Workspaces</th><th>Active jobs</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>${table}</tbody></table></div></section>`;
}
function activeRunnerLabel(client: McpClientRecord, runners: readonly RunnerRecord[]): string { const runner = client.active_runner_id === null ? undefined : runners.find((item) => item.runner_id === client.active_runner_id); return runner === undefined ? "Not selected" : runner.display_name; }
function clientsPage(data: AdminData, csrf: string): string {
  const rows = data.clients.map((client) => `<tr><td><span class="strong">${escapeHtml(client.label)}</span><small>${escapeHtml(client.client_id)}</small></td><td>${escapeHtml(client.scopes.join(", "))}</td><td>${escapeHtml(activeRunnerLabel(client, data.runners))}</td><td>${escapeHtml(time(client.last_used_at_ms))}</td><td>${client.revoked_at_ms === null ? statusBadge("online") : statusBadge("offline")}</td><td class="actions"><form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rename"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input name="label" value="${escapeHtml(client.label)}" aria-label="Rename ${escapeHtml(client.label)}" maxlength="256"><button class="small secondary">Rename</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rotate"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Rotate</button></form>` : ""}<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/reset-runner"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small secondary">Reset Runner Selection</button></form>${client.revoked_at_ms === null ? `<form method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/revoke"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="small danger">Revoke</button></form>` : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No MCP clients yet.</td></tr>`;
  return `<section class="page-heading"><div><p class="eyebrow">Integrations</p><h1>MCP Clients</h1><p class="lede">Manage labels, scopes, runner routing, and one-time client secrets.</p></div></section><section class="panel" id="add-client"><div class="section-title"><h2>Add MCP Client</h2></div><form method="post" action="/admin/clients" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Label<input name="label" maxlength="256" required></label><fieldset><legend>Scopes</legend>${scopeCheckboxes()}</fieldset><button class="button">Create one-time secret</button></form></section><section class="panel"><div class="table-wrap"><table><caption class="sr-only">MCP clients</caption><thead><tr><th>Label</th><th>Scopes</th><th>Active runner</th><th>Last used</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
function settingsPage(csrf: string): string { return `<section class="page-heading"><div><p class="eyebrow">Workspace administration</p><h1>Settings</h1><p class="lede">Keep operator notes here; credentials and secrets are never displayed.</p></div></section><div class="grid-two"><section class="panel"><h2>Change password</h2><form method="post" action="/admin/password" class="stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Current password<input type="password" name="current_password" required autocomplete="current-password"></label><label>New password<input type="password" name="password" minlength="12" required autocomplete="new-password"></label><label>Confirm new password<input type="password" name="confirm_password" minlength="12" required autocomplete="new-password"></label><button class="button">Change password</button></form></section><section class="panel"><h2>Operator notes</h2><p class="muted">Deployment notes belong in your deployment system. This dashboard intentionally stores no notes or secrets.</p><form method="post" action="/admin/logout" class="stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button secondary">Log out</button></form></section></div>`; }
function runnerList(runners: readonly RunnerRecord[]): string { return runners.length === 0 ? `<p class="empty">No runners yet.</p>` : `<ul class="item-list">${runners.map((runner) => `<li><a href="/admin/runners/${encodeURIComponent(runner.runner_id)}"><span class="strong">${escapeHtml(runner.display_name)}</span><small>${statusBadge(runner.state)} · ${escapeHtml(safePlatform(runner))}</small></a></li>`).join("")}</ul>`; }
function clientList(clients: readonly McpClientRecord[]): string { return clients.length === 0 ? `<p class="empty">No MCP clients yet.</p>` : `<ul class="item-list">${clients.map((client) => `<li><span><span class="strong">${escapeHtml(client.label)}</span><small>${client.active_runner_id === null ? "Not selected" : escapeHtml(client.active_runner_id)} · ${client.revoked_at_ms === null ? "Active" : "Revoked"}</small><form class="hidden" method="post" action="/admin/clients/${encodeURIComponent(client.client_id)}/rename"><input name="label" value="${escapeHtml(client.label)}"></form></span></li>`).join("")}</ul>`; }
function jobTable(jobs: readonly Record<string, unknown>[]): string { return jobs.length === 0 ? `<p class="empty">No recent jobs.</p>` : `<div class="table-wrap"><table><thead><tr><th>Job</th><th>Workspace</th><th>Status</th><th>Updated</th></tr></thead><tbody>${jobs.map((job) => `<tr><td>${escapeHtml(String(job.job_id ?? "unknown"))}</td><td>${escapeHtml(String(job.workspace_id ?? "unknown"))}</td><td>${escapeHtml(String(job.status ?? "unknown"))}</td><td>${escapeHtml(time(typeof job.updated_at_ms === "number" ? job.updated_at_ms : null))}</td></tr>`).join("")}</tbody></table></div>`; }
function statusBadge(state: string): string { const safe = ["online", "offline", "stale"].includes(state) ? state : "offline"; return `<span class="badge ${safe}">${safe}</span>`; }
function safePlatform(runner: RunnerRecord): string { return runner.public_info === null ? "Not enrolled" : `${runner.public_info.platform} / ${runner.public_info.architecture}`; }
function runnerWorkspaceCount(runner: RunnerRecord): string { const value = (runner as RunnerRecord & { workspace_count?: unknown }).workspace_count; return typeof value === "number" ? String(value) : "—"; }
function runnerActiveJobs(runner: RunnerRecord): string { const value = (runner as RunnerRecord & { active_job_count?: unknown }).active_job_count; return typeof value === "number" ? String(value) : "—"; }
function scopeCheckboxes(): string { return ["coding:read", "coding:write", "coding:exec"].map((scope) => `<label class="check"><input type="checkbox" name="scopes" value="${scope}" checked> ${scope}</label>`).join(""); }
function runnerDetailPage(runner: Record<string, unknown>, workspaces: readonly unknown[], jobs: readonly unknown[], environment: Record<string, unknown> | undefined, csrf: string, release: RunnerReleaseDescriptor & { readonly distributable: boolean }): string {
  const runnerId = typeof runner.runner_id === "string" ? runner.runner_id : "unknown";
  const displayName = typeof runner.display_name === "string" ? runner.display_name : runnerId;
  const state = typeof runner.state === "string" ? runner.state : "offline";
  const publicInfo = record(runner.public_info);
  const tools = record(environment?.tools);
  const toolRows = tools === undefined ? `<p class="muted">Environment details unavailable while offline.</p>` : `<div class="tool-grid">${Object.entries(tools).map(([name, value]) => { const item = record(value); return `<div><strong>${escapeHtml(name)}</strong><span>${item?.available === true ? `Available${typeof item.version === "string" ? ` · ${escapeHtml(item.version)}` : ""}` : "Unavailable"}</span></div>`; }).join("")}</div>`;
  const workspaceRows = workspaces.map((workspace) => managedWorkspaceForm(runnerId, record(workspace), csrf)).join("") || `<li class="muted">No managed workspaces configured.</li>`;
  const permissions = record(runner.runner_permissions);
  const updateChannel = runner.update_channel === "pinned" ? "pinned" : "stable";
  const currentVersion = typeof runner.current_runner_version === "string" ? runner.current_runner_version : typeof publicInfo?.runner_version === "string" ? publicInfo.runner_version : "Unknown";
  const latestVersion = typeof runner.latest_runner_version === "string" ? runner.latest_runner_version : release.latest_version;
  const desiredVersion = typeof runner.desired_runner_version === "string" ? runner.desired_runner_version : "";
  const protocolCompatibility = runner.protocol_compatibility === "compatible" || runner.protocol_compatibility === "incompatible" ? runner.protocol_compatibility : "unknown";
  const protocolRange = `${String(runner.protocol_min_version ?? "Unknown")}–${String(runner.protocol_max_version ?? "Unknown")}`;
  const policyStatus = runner.policy_status === "applied" || runner.policy_status === "invalid" ? runner.policy_status : "pending";
  const desiredRevision = typeof runner.desired_policy_revision === "number" ? String(runner.desired_policy_revision) : "0";
  const appliedRevision = typeof runner.applied_policy_revision === "number" ? String(runner.applied_policy_revision) : "—";
  return `<section class="page-heading"><div><p class="eyebrow">Runner details</p><h1>${escapeHtml(displayName)}</h1><p class="lede">Control-plane workspace roots appear only in this authenticated administrator view.</p></div><a class="button secondary" href="/admin/runners">Back to runners</a></section><div class="metrics"><div class="metric"><span>Status</span><strong>${statusBadge(state)}</strong></div><div class="metric"><span>Runner ID</span><strong class="mono">${escapeHtml(runnerId)}</strong></div><div class="metric"><span>Policy status</span><strong>${escapeHtml(policyStatus)} · ${escapeHtml(appliedRevision)} / ${escapeHtml(desiredRevision)}</strong></div><div class="metric"><span>Last seen</span><strong>${escapeHtml(time(typeof runner.last_heartbeat_ms === "number" ? runner.last_heartbeat_ms : null))}</strong></div></div><div class="grid-two"><section class="panel"><h2>Safe metadata</h2><dl class="details"><dt>Platform</dt><dd>${escapeHtml(typeof publicInfo?.platform === "string" ? publicInfo.platform : "Unknown")}</dd><dt>Architecture</dt><dd>${escapeHtml(typeof publicInfo?.architecture === "string" ? publicInfo.architecture : "Unknown")}</dd><dt>Hostname</dt><dd>${escapeHtml(typeof publicInfo?.hostname === "string" ? publicInfo.hostname : "Unknown")}</dd><dt>Runner version</dt><dd>${escapeHtml(currentVersion)}</dd><dt>Stable/latest version</dt><dd>${escapeHtml(latestVersion)}</dd><dt>Protocol compatibility</dt><dd>${escapeHtml(protocolRange)} · ${escapeHtml(protocolCompatibility)}</dd></dl></section><section class="panel"><h2>Version policy</h2><p class="muted">Policy is recorded for operators; package download, update, and rollback remain deferred.</p><form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/version-policy" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Channel<select name="update_channel"><option value="stable"${updateChannel === "stable" ? " selected" : ""}>Stable</option><option value="pinned"${updateChannel === "pinned" ? " selected" : ""}>Pinned</option></select></label><label>Desired version<input name="desired_runner_version" value="${escapeHtml(desiredVersion)}" placeholder="1.2.3" pattern="[0-9]+\\.[0-9]+\\.[0-9]+"></label><div><strong>Current</strong><span>${escapeHtml(currentVersion)}</span></div><div><strong>Latest</strong><span>${escapeHtml(latestVersion)}</span></div><button class="button">Save version policy</button></form><p class="muted">Status: ${escapeHtml(String(runner.update_status ?? "unknown"))}</p></section><section class="panel"><h2>Environment tools</h2>${toolRows}</section></div><div class="grid-two"><section class="panel"><h2>Runner permission profile</h2><p class="muted">Changes remain pending until the connected Runner validates and applies the revision.</p>${permissionForm(runnerId, permissions, csrf)}<form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/emergency-lock" class="stack"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button danger">Emergency lock all permissions</button></form></section><section class="panel"><h2>Active jobs</h2>${jobTable(jobs.filter(record) as Record<string, unknown>[])}</section></div><section class="panel"><div class="section-title"><h2>Managed workspaces</h2><span class="muted">Each save increments the desired policy revision.</span></div><ul class="plain-list">${workspaceRows}</ul><h3>Add workspace</h3>${managedWorkspaceForm(runnerId, undefined, csrf)}</section>`;
}
function permissionForm(runnerId: string, permissions: Record<string, unknown> | undefined, csrf: string): string {
  const current = (name: string): boolean => permissions?.[name] === true;
  return `<form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/permissions" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">${permissionSelect("read", current("read"))}${permissionSelect("edit", current("edit"))}${permissionSelect("shell", current("shell"))}${permissionSelect("job_control", current("job_control"))}<button class="button">Save profile</button></form>`;
}
function permissionSelect(name: string, selected: boolean): string { return `<label>${escapeHtml(name.replaceAll("_", " "))}<select name="${escapeHtml(name)}"><option value="true"${selected ? " selected" : ""}>Allow</option><option value="false"${selected ? "" : " selected"}>Deny</option></select></label>`; }
function managedWorkspaceForm(runnerId: string, workspace: Record<string, unknown> | undefined, csrf: string): string {
  const existing = typeof workspace?.workspace_id === "string";
  const workspaceId = existing ? workspace?.workspace_id as string : "";
  const displayName = typeof workspace?.display_name === "string" ? workspace.display_name : "";
  const rootPath = typeof workspace?.root_path === "string" ? workspace.root_path : "";
  const permissions = record(workspace?.permissions);
  const current = (name: string): boolean => permissions?.[name] === true;
  const enabled = workspace?.enabled !== false;
  const status = typeof workspace?.validation_status === "string" ? workspace.validation_status : "pending";
  return `<li class="workspace-card"><form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/${existing ? "workspace-update" : "workspace-create"}" class="form-grid"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><label>Workspace ID<input name="workspace_id" value="${escapeHtml(workspaceId)}" ${existing ? "readonly" : "required"} maxlength="128"></label><label>Display name<input name="display_name" value="${escapeHtml(displayName)}" required maxlength="256"></label><label>Absolute root path<input name="root_path" value="${escapeHtml(rootPath)}" required maxlength="4096"></label><label>Enabled<select name="enabled"><option value="true"${enabled ? " selected" : ""}>Enabled</option><option value="false"${enabled ? "" : " selected"}>Disabled</option></select></label>${permissionSelect("read", current("read"))}${permissionSelect("edit", current("edit"))}${permissionSelect("shell", current("shell"))}${permissionSelect("job_control", current("job_control"))}<button class="button">${existing ? "Save workspace" : "Create workspace"}</button></form>${existing ? `<div class="top-actions"><span class="muted">Validation: ${escapeHtml(status)}</span><form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/workspace-delete"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="workspace_id" value="${escapeHtml(workspaceId)}"><button class="small danger">Delete workspace</button></form></div>` : ""}</li>`;
}
function adminStyles(): string { return `<style>
:root{color-scheme:light;--ink:#152033;--muted:#607086;--line:#dbe3ed;--panel:#fff;--canvas:#f5f7fa;--brand:#155eef;--danger:#b42318;--shadow:0 8px 24px #172b4d0d}*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:1440px;margin:auto;padding:0 28px 48px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:24px 0}.brand{color:var(--ink);font-size:20px;font-weight:760;text-decoration:none;display:inline-flex;align-items:center;gap:10px}.brand-logo{display:block;width:40px;height:40px;object-fit:contain;border-radius:9px}.top-actions,.actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}nav{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:32px}nav a{padding:11px 16px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent}nav a:hover,nav a.active{color:var(--brand);border-color:var(--brand)}h1,h2,h3{line-height:1.2;margin:0 0 8px}h1{font-size:32px;letter-spacing:-.02em}h2{font-size:18px}.page-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:24px}.eyebrow{color:var(--brand);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0 0 8px}.lede,.muted{color:var(--muted)}.lede{margin:0}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}.metric,.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}.metric{padding:20px}.metric span{display:block;color:var(--muted);font-size:13px;margin-bottom:8px}.metric strong{font-size:24px}.grid-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:24px}.panel{padding:22px;margin-bottom:24px}.section-title{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:16px}.section-title a{color:var(--brand);font-weight:650;text-decoration:none}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}th,td{text-align:left;padding:13px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}tr:last-child td{border-bottom:0}.strong{font-weight:700;color:var(--ink)}small{display:block;color:var(--muted);font-size:12px;margin-top:3px}.button,button{appearance:none;border:1px solid var(--brand);background:var(--brand);border-radius:7px;color:#fff;cursor:pointer;font:inherit;font-weight:650;padding:9px 14px;text-decoration:none;display:inline-block}.button.secondary,button.secondary{background:#fff;color:var(--brand);border-color:#b9c9e8}.button.small,button.small{font-size:12px;padding:6px 9px}.danger{color:var(--danger)!important;border-color:#f2b8b5!important;background:#fff!important}.badge{border-radius:999px;display:inline-block;font-size:12px;font-weight:700;padding:3px 8px;text-transform:capitalize}.badge.online{background:#d1fadf;color:#067647}.badge.offline{background:#eef2f6;color:#475467}.badge.stale{background:#fef0c7;color:#b54708}.form-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:end;gap:14px}label{display:flex;flex-direction:column;gap:6px;font-weight:650}input,select{border:1px solid #b8c4d3;border-radius:6px;padding:9px 10px;font:inherit;color:var(--ink);min-width:0}fieldset{border:0;padding:0;margin:0}.check{display:inline-flex;flex-direction:row;align-items:center;font-weight:400;margin-right:16px}.check input{min-width:auto}.stack{display:flex;flex-direction:column;gap:14px;max-width:520px}.item-list,.plain-list{list-style:none;padding:0;margin:0}.item-list li{border-bottom:1px solid var(--line);padding:12px 0}.item-list li:last-child{border:0}.item-list a{display:block;text-decoration:none}.empty{color:var(--muted);padding:12px 0}.details{display:grid;grid-template-columns:140px 1fr;gap:10px;margin:0}.details dt{color:var(--muted)}.details dd{margin:0;font-weight:650;overflow-wrap:anywhere}.tool-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.tool-grid div{border:1px solid var(--line);border-radius:8px;padding:10px}.tool-grid span{display:block;color:var(--muted);font-size:13px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.hidden{display:none}.workspace-card{border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:12px}:focus-visible{outline:3px solid #84adff;outline-offset:2px}@media(max-width:800px){.shell{padding:0 16px 32px}.topbar,.page-heading{align-items:stretch;flex-direction:column}.brand{align-self:flex-start}.top-actions{width:100%}.top-actions .button{flex:1;text-align:center}nav{overflow-x:auto;margin-bottom:24px}.metrics,.grid-two,.form-grid{grid-template-columns:1fr 1fr}.panel{padding:16px}.actions{min-width:210px}.tool-grid{grid-template-columns:1fr}}@media(max-width:480px){.metrics,.grid-two,.form-grid{grid-template-columns:1fr}h1{font-size:27px}}
</style>`; }
function adminScript(): string { return `<script>function copyText(text){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text);return}var area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove()}document.querySelectorAll('[data-copy]').forEach(function(button){button.addEventListener('click',function(){copyText(button.getAttribute('data-copy')||'');button.textContent='Copied'})});document.querySelectorAll('[data-tab]').forEach(function(tab){tab.addEventListener('click',function(){var target=tab.getAttribute('data-tab');document.querySelectorAll('[data-tab]').forEach(function(item){item.setAttribute('aria-selected',String(item===tab));item.tabIndex=item===tab?0:-1});document.querySelectorAll('[data-panel]').forEach(function(panel){panel.hidden=panel.getAttribute('data-panel')!==target})});tab.addEventListener('keydown',function(event){if(event.key==='ArrowLeft'||event.key==='ArrowRight'){var tabs=Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));var next=tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length];next.focus();next.click()}})});document.querySelectorAll('[data-refresh]').forEach(function(button){button.addEventListener('click',function(){location.reload()})});setTimeout(function(){location.reload()},10000);</script>`; }
function runnerEnrollmentPage(baseUrl: string, runnerId: string, code: string | undefined, csrf: string, reEnroll = false): Response {
  if (code === undefined) return adminError(503, "Enrollment code could not be generated.");
  const installSh = `curl -fsSL ${new URL("/runner/install.sh", baseUrl).toString()} | sh -s -- ${code}${reEnroll ? " --re-enroll" : ""}`;
  const installPs1 = `& ([scriptblock]::Create((Invoke-RestMethod -Uri '${new URL("/runner/install.ps1", baseUrl).toString()}'))) -EnrollmentCode '${code}'${reEnroll ? " -ReEnroll" : ""}`;
  const commands = { linux: installSh, macos: installSh, windows: installPs1 };
  const tabs = Object.entries(commands).map(([platform, command], index) => `<button role="tab" id="tab-${platform}" aria-controls="panel-${platform}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}" data-tab="${platform}">${platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux"}</button><section role="tabpanel" id="panel-${platform}" aria-labelledby="tab-${platform}" ${index === 0 ? "" : "hidden"} data-panel="${platform}"><pre><code>${escapeHtml(command)}</code></pre><button type="button" class="button secondary" data-copy="${escapeHtml(command)}">Copy command</button></section>`).join("");
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Runmesh · Agent Control Plane enrollment</title>${adminStyles()}</head><body><main class="shell"><dialog open aria-labelledby="enrollment-title" class="enrollment-dialog"><section class="page-heading"><div><p class="eyebrow">One-time enrollment</p><h1 id="enrollment-title">Install runner</h1><p class="lede">This code expires in 30 minutes and will not be shown again. It creates the runner credential only after it is redeemed.</p></div></section><p class="muted">Runner: <span class="mono">${escapeHtml(runnerId)}</span></p><div role="tablist" aria-label="Operating system" class="tabs">${tabs}</div><p class="warning">Do not share this command. It contains a one-time enrollment code, not an administrator password, MCP secret, or long-term credential.</p><div class="top-actions"><form method="post" action="/admin/runners/${encodeURIComponent(runnerId)}/enrollment"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button secondary">Regenerate enrollment</button></form><a class="button" href="/admin/runners">Done</a></div></dialog></main>${adminScript()}</body></html>`);
}
function secretCreatedPage(title: string, url: string): string { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><p>Copy this URL now. It will not be shown again.</p><code>${escapeHtml(url)}</code><p><a href="/admin">Back to admin</a></p></main></body></html>`; }
function secretUrl(base: string, secret: string): string { const url = new URL(base); url.pathname = `/${secret}/mcp`; url.search = ""; return url.toString(); }
function selectedScopes(form: FormData): CodingScope[] | undefined { const values = form.getAll("scopes"); const scopes = values.filter((value): value is CodingScope => value === "coding:read" || value === "coding:write" || value === "coding:exec"); return scopes.length === values.length && scopes.length > 0 && new Set(scopes).size === scopes.length ? scopes : undefined; }
function validPassword(password: string): boolean { return password.length >= 12 && password.length <= 1_024; }
function validLabel(label: string): boolean { return label.trim().length > 0 && label.length <= 256; }
function validRunnerVersion(value: string): boolean { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value); }

async function forwardRunnerRpc(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method !== "POST" || segments.length !== 4 || segments[0] !== "internal" || segments[1] !== "runners" || segments[3] !== "rpc" || !isSafeIdentifier(segments[2] ?? "")) return notFound();
  const body = await request.text();
  if (!await verifyInternalRequest(request, env.INTERNAL_CONTROL_SECRET, body)) return notFound();
  const runnerId = segments[2] as string; const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/rpc", body);
  return env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/rpc", { method: "POST", headers, body }));
}

async function handleRunnerAdmin(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  if (!isRunnerAdminRequest(request, env)) { await discardBody(request); return new Response("unauthorized", { status: 401 }); }
  if (env.INTERNAL_CONTROL_SECRET === undefined || env.RUNNER_TOKEN_PEPPER === undefined) { await discardBody(request); return new Response("admin control plane is not configured", { status: 503 }); }
  const segments = url.pathname.split("/").filter(Boolean); const runnerId = segments[2]; const action = segments[3];
  if (segments.length === 2 && request.method === "POST") {
    const input = await readAdminBody(request); const id = typeof input?.runner_id === "string" && isSafeIdentifier(input.runner_id) ? input.runner_id : undefined;
    if (id === undefined) return Response.json({ error: "runner_id must be a safe identifier" }, { status: 400 });
    return registerRunner(env, id, input);
  }
  if (runnerId === undefined || !isSafeIdentifier(runnerId) || action === undefined || segments.length !== 4 || request.method !== "POST") { await discardBody(request); return notFound(); }
  if (action === "rotate") return registerRunner(env, runnerId, await readAdminBody(request));
  if (action === "revoke") { const response = await runnerRegistryRequest(env, runnerId, "/revoke", "POST", "{}"); if (!response.ok) return new Response("registry unavailable", { status: 502 }); await closeRunnerSockets(env, runnerId); return new Response(null, { status: 204 }); }
  return notFound();
}
async function registerRunner(env: WorkerEnv, runnerId: string, input: Record<string, unknown> | undefined): Promise<Response> {
  const supplied = input?.token;
  if (supplied !== undefined && (typeof supplied !== "string" || supplied.length < 32 || supplied.length > 512 || /\s/.test(supplied))) return Response.json({ error: "token must be 32-512 non-whitespace characters" }, { status: 400 });
  const token = typeof supplied === "string" ? supplied : generateRunnerToken(); const pepper = env.RUNNER_TOKEN_PEPPER;
  if (pepper === undefined) return new Response("admin control plane is not configured", { status: 503 });
  const response = await runnerRegistryRequest(env, runnerId, "", "PUT", JSON.stringify({ token_verifier: await runnerTokenVerifier(token, pepper) }));
  if (!response.ok) return new Response("registry unavailable", { status: 502 });
  await closeRunnerSockets(env, runnerId);
  return Response.json({ runner_id: runnerId, token }, { headers: credentialHeaders("application/json; charset=utf-8") });
}
async function closeRunnerSockets(env: WorkerEnv, runnerId: string): Promise<void> { const body = "{}"; const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", "/revoke", body); await env.RUNNER.get(env.RUNNER.idFromName(runnerId)).fetch(new Request("https://runner.internal/revoke", { method: "POST", headers, body })); }
function isRunnerAdminRequest(request: Request, env: WorkerEnv): boolean { const token = bearerToken(request); return token !== undefined && env.ADMIN_TOKEN !== undefined && constantTimeEqual(token, env.ADMIN_TOKEN); }
async function runnerRegistryRequest(env: WorkerEnv, runnerId: string, action: string, method: string, body: string): Promise<Response> { const path = `/runners/${encodeURIComponent(runnerId)}${action}`; const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET as string, method, path, body); return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method, body, headers })); }

async function verifyMcpClient(env: WorkerEnv, secretVerifier: string): Promise<VerifiedMcpClient | undefined> { const response = await registryPost(env, "/auth/mcp/verify", { secret_verifier: secretVerifier }); const body = response.ok ? record(await json(response)) : undefined; if (body === undefined || typeof body.client_id !== "string" || typeof body.label !== "string" || typeof body.secret_version !== "number" || !Array.isArray(body.scopes) || body.scopes.some((scope) => scope !== "coding:read" && scope !== "coding:write" && scope !== "coding:exec")) return undefined; return { client_id: body.client_id, label: body.label, secret_version: body.secret_version, scopes: body.scopes as CodingScope[] }; }
async function registryGet(env: WorkerEnv, path: string): Promise<Response> { const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "GET", path, ""); return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { headers })); }
async function registryPost(env: WorkerEnv, path: string, payload: Record<string, unknown>): Promise<Response> { const body = JSON.stringify(payload); const headers = await internalHeaders(env.INTERNAL_CONTROL_SECRET ?? "", "POST", path, body); return env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch(new Request(`https://registry.internal${path}`, { method: "POST", headers, body })); }
type PreAuthThrottle = { readonly allowed: boolean; readonly retry_after_ms: number };
async function authThrottleCheck(env: WorkerEnv, kind: "login" | "setup"): Promise<PreAuthThrottle | undefined> {
  const response = await registryPost(env, "/auth/throttle/check", { kind });
  const body = response.ok ? record(await json(response)) : undefined;
  return body !== undefined && typeof body.allowed === "boolean" && typeof body.retry_after_ms === "number" && Number.isSafeInteger(body.retry_after_ms) && body.retry_after_ms >= 0
    ? { allowed: body.allowed, retry_after_ms: body.retry_after_ms }
    : undefined;
}
async function authThrottleRecord(env: WorkerEnv, kind: "login" | "setup", success: boolean): Promise<void> {
  // The request includes only outcome metadata; passwords/verifiers never enter logs.
  try { await registryPost(env, "/auth/throttle/record", { kind, success }); } catch { /* authentication result remains authoritative */ }
}
function throttleError(retryAfterMs: number): Response {
  const headers = htmlHeaders();
  headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1_000))));
  return new Response("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><link rel=\"icon\" href=\"/assets/favicon.png\" type=\"image/png\"><title>Runmesh · Agent Control Plane</title></head><body><main><h1>Runmesh</h1><p>Agent Control Plane</p><p>Invalid administrator password.</p><p>Please try again shortly.</p></main></body></html>", { status: 403, headers });
}
async function formData(request: Request): Promise<FormData | undefined> { const length = request.headers.get("content-length"); if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ADMIN_BODY_BYTES)) { await discardBody(request); return undefined; } try { const form = await request.formData(); let size = 0; for (const [key, value] of form) { if (typeof value !== "string") return undefined; size += new TextEncoder().encode(key).byteLength + new TextEncoder().encode(value).byteLength; } return size <= MAX_ADMIN_BODY_BYTES ? form : undefined; } catch { return undefined; } }
async function readAdminBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ADMIN_BODY_BYTES)) { await discardBody(request); return undefined; }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_ADMIN_BODY_BYTES) return undefined;
  try { const value = JSON.parse(body) as unknown; return record(value); } catch { return undefined; }
}
async function discardBody(request: Request): Promise<void> {
  // Do not allocate an unbounded invalid request body before returning an auth
  // response. Cancelling the stream releases the Worker-side reader.
  try { await request.body?.cancel(); } catch { /* already consumed */ }
}
function cookieValue(request: Request, name: string): string | undefined { const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const match = new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`).exec(request.headers.get("cookie") ?? ""); return match?.[1]; }
function sessionCookie(value: string): string { return `${ADMIN_SESSION_COOKIE}=${value}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1_000)}`; }
function csrfCookie(value: string): string { return `${ADMIN_CSRF_COOKIE}=${value}; Secure; Path=/; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1_000)}`; }
function clearCookie(name: string): string { return `${name}=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0`; }
function credentialHeaders(contentType: string): Headers { const headers = htmlHeaders(); headers.set("content-type", contentType); return headers; }
function html(value: string, cookies: readonly string[] = []): Response { const headers = htmlHeaders(); for (const cookie of cookies) headers.append("set-cookie", cookie); return new Response(value, { headers }); }
function htmlHeaders(): Headers { return new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "x-frame-options": "DENY" }); }
function redirect(location: string, cookies: readonly string[] = []): Response { const headers = htmlHeaders(); headers.set("location", location); for (const cookie of cookies) headers.append("set-cookie", cookie); return new Response(null, { status: 303, headers }); }
function adminError(status: number, message: string, cookies: readonly string[] = []): Response { const response = html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/assets/favicon.png" type="image/png"><title>Runmesh · Agent Control Plane</title></head><body><main><h1>Runmesh</h1><p>Agent Control Plane</p><p>${escapeHtml(message)}</p><p><a href="/">Return</a></p></main></body></html>`, cookies.length === 0 ? [] : cookies); return new Response(response.body, { status, headers: response.headers }); }
function methodNotAllowed(allow: string): Response { return new Response("Method not allowed", { status: 405, headers: { allow } }); }
function notFound(): Response { return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } }); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] as string); }
function time(value: number | null): string { return value === null ? "Never" : new Date(value).toISOString(); }
async function json(response: Response): Promise<unknown> { try { return await response.json(); } catch { return undefined; } }
function arrayField(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
