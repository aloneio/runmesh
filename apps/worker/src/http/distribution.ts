import { configuredPublicOrigin } from "./origin.js";
import { discardBody } from "./request.js";
import { FIXED_RELEASE_VERSION } from "../installer.js";
import { methodNotAllowed } from "./responses.js";
import { renderPosixInstaller } from "../installer.js";
import { renderPosixUninstaller } from "../installer.js";
import { renderPowerShellInstaller } from "../installer.js";
import { renderPowerShellUninstaller } from "../installer.js";
import { resolvePublicOrigin } from "../installer.js";
import { runnerReleaseDescriptor } from "../distribution/release.js";
import type { RunnerReleaseEnvironment } from "../distribution/release.js";
import type { WorkerEnv } from "../platform/env.js";

export function runnerRelease(request: Request, env: WorkerEnv): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const descriptor = runnerReleaseDescriptor(env);
  return new Response(JSON.stringify({ ...descriptor, schema_version: 1, published_at: null }), { headers: publicInstallerHeaders("application/json; charset=utf-8") });
}

export function runnerInstallScript(request: Request, url: URL, env: RunnerReleaseEnvironment): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const modes = url.searchParams.getAll("execution_mode");
  const mode = modes[0] ?? "privileged_host";
  if (modes.length > 1 || (mode !== "dedicated_user" && mode !== "privileged_host")) return new Response("invalid installer execution mode", { status: 400, headers: { "cache-control": "no-store" } });
  const descriptor = runnerReleaseDescriptor(env);
  let content: string;
  if (descriptor.distributable) {
    try { content = renderPosixInstaller(resolvePublicOrigin(request, configuredPublicOrigin(env)), mode); }
    catch { return installerOriginUnavailable(); }
  } else {
    content =
`#!/usr/bin/env sh
set -eu
printf '%s\\n' 'error: The fixed signed Runmesh v${FIXED_RELEASE_VERSION} release is not enabled on this deployment.' 'Use the manual verified portable-artifact route until the exact immutable release is available.' >&2
exit 1
`;
  }
  return new Response(content, { headers: publicInstallerHeaders("text/x-shellscript; charset=utf-8") });
}

export function runnerInstallPowerShell(request: Request, url: URL, env: RunnerReleaseEnvironment): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const modes = url.searchParams.getAll("execution_mode");
  const mode = modes[0] ?? "privileged_host";
  if (modes.length > 1 || (mode !== "dedicated_user" && mode !== "privileged_host")) return new Response("invalid installer execution mode", { status: 400, headers: { "cache-control": "no-store" } });
  const descriptor = runnerReleaseDescriptor(env);
  let content: string;
  if (descriptor.distributable) {
    try { content = renderPowerShellInstaller(resolvePublicOrigin(request, configuredPublicOrigin(env)), mode); }
    catch { return installerOriginUnavailable(); }
  } else {
    content = `$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Write-Error 'The fixed signed Runmesh v${FIXED_RELEASE_VERSION} release is not enabled on this deployment. Use the manual verified portable-artifact route until the exact immutable release is available.'
exit 1
`;
  }
  return new Response(content, { headers: publicInstallerHeaders("text/plain; charset=utf-8") });
}

export function runnerUninstallScript(request: Request, env: RunnerReleaseEnvironment, windows: boolean): Response {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  if (!runnerReleaseDescriptor(env).distributable) return new Response("Runmesh maintenance download is not enabled on this deployment", { status: 503, headers: { "cache-control": "no-store" } });
  try {
    const origin = resolvePublicOrigin(request, configuredPublicOrigin(env));
    const script = windows ? renderPowerShellUninstaller(origin) : renderPosixUninstaller(origin);
    const headers = publicInstallerHeaders(windows ? "text/plain; charset=utf-8" : "text/x-shellscript; charset=utf-8");
    headers.set("cache-control", "no-store");
    return new Response(script, { headers });
  } catch { return installerOriginUnavailable(); }
}

export function installerOriginUnavailable(): Response {
  return new Response("hosted installer is unavailable for this request origin", { status: 421, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
}

export function publicInstallerHeaders(contentType: string): Headers {
  return new Headers({ "content-type": contentType, "cache-control": "public, max-age=300", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "permissions-policy": "geolocation=(), microphone=(), camera=()" });
}
