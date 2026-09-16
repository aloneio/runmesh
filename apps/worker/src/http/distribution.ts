import { configuredPublicOrigin } from "./origin.js";
import { discardBody } from "./request.js";
import { installerReleaseTarget, renderPosixInstaller, renderPosixUninstaller, renderPowerShellInstaller, renderPowerShellUninstaller, resolvePublicOrigin } from "../installer.js";
import { methodNotAllowed } from "./responses.js";
import { resolveDevelopmentRunnerRelease, resolveRunnerReleaseDescriptor, runnerReleaseDescriptor } from "../distribution/release.js";
import type { RunnerReleaseDescriptor } from "../distribution/release.js";
import type { WorkerEnv } from "../platform/env.js";

type ReleaseSelection = "selected" | "stable" | "dev";
async function selectedRelease(env: WorkerEnv, selection: ReleaseSelection): Promise<RunnerReleaseDescriptor> {
  if (selection === "stable") return runnerReleaseDescriptor(env);
  if (selection === "dev") return resolveDevelopmentRunnerRelease(env);
  return resolveRunnerReleaseDescriptor(env);
}
function releaseTarget(descriptor: RunnerReleaseDescriptor) {
  if (!descriptor.distributable || descriptor.package_version.length === 0) throw new Error("Runner release is unavailable");
  return installerReleaseTarget(descriptor.package_version, descriptor.channel);
}
function unavailableScript(channel: "dev" | "stable", windows: boolean): string {
  const message = channel === "dev"
    ? "No immutable signed Runmesh development Runner prerelease is currently available. Development never falls back to the stable Runner."
    : "The fixed signed Runmesh stable Runner release is not enabled on this deployment.";
  return windows
    ? `$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\nWrite-Error '${message}'\nexit 1\n`
    : `#!/usr/bin/env sh\nset -eu\nprintf '%s\\n' '${message}' >&2\nexit 1\n`;
}

export async function runnerRelease(request: Request, env: WorkerEnv, selection: ReleaseSelection = "selected"): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const descriptor = await selectedRelease(env, selection);
  const headers = publicInstallerHeaders("application/json; charset=utf-8");
  if (descriptor.channel === "dev" && !descriptor.distributable) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify({ ...descriptor, schema_version: 1 }), { headers });
}

export async function runnerInstallScript(request: Request, url: URL, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const modes = url.searchParams.getAll("execution_mode"); const mode = modes[0] ?? "privileged_host";
  if (modes.length > 1 || (mode !== "dedicated_user" && mode !== "privileged_host")) return new Response("invalid installer execution mode", { status: 400, headers: { "cache-control": "no-store" } });
  const descriptor = await resolveRunnerReleaseDescriptor(env); let content: string;
  if (descriptor.distributable) {
    try { content = renderPosixInstaller(resolvePublicOrigin(request, configuredPublicOrigin(env)), mode, releaseTarget(descriptor)); }
    catch { return installerOriginUnavailable(); }
  } else content = unavailableScript(descriptor.channel, false);
  const headers = publicInstallerHeaders("text/x-shellscript; charset=utf-8");
  if (descriptor.channel === "dev" && !descriptor.distributable) headers.set("cache-control", "no-store");
  return new Response(content, { headers });
}

export async function runnerInstallPowerShell(request: Request, url: URL, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const modes = url.searchParams.getAll("execution_mode"); const mode = modes[0] ?? "privileged_host";
  if (modes.length > 1 || (mode !== "dedicated_user" && mode !== "privileged_host")) return new Response("invalid installer execution mode", { status: 400, headers: { "cache-control": "no-store" } });
  const descriptor = await resolveRunnerReleaseDescriptor(env); let content: string;
  if (descriptor.distributable) {
    try { content = renderPowerShellInstaller(resolvePublicOrigin(request, configuredPublicOrigin(env)), mode, releaseTarget(descriptor)); }
    catch { return installerOriginUnavailable(); }
  } else content = unavailableScript(descriptor.channel, true);
  const headers = publicInstallerHeaders("text/plain; charset=utf-8");
  if (descriptor.channel === "dev" && !descriptor.distributable) headers.set("cache-control", "no-store");
  return new Response(content, { headers });
}

export async function runnerUninstallScript(request: Request, env: WorkerEnv, windows: boolean): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") { void discardBody(request); return methodNotAllowed("GET, HEAD"); }
  const descriptor = await resolveRunnerReleaseDescriptor(env);
  if (!descriptor.distributable) return new Response("Runmesh maintenance download is not enabled on this deployment", { status: 503, headers: { "cache-control": "no-store" } });
  try {
    const origin = resolvePublicOrigin(request, configuredPublicOrigin(env)); const target = releaseTarget(descriptor);
    const script = windows ? renderPowerShellUninstaller(origin, target) : renderPosixUninstaller(origin, target);
    const headers = publicInstallerHeaders(windows ? "text/plain; charset=utf-8" : "text/x-shellscript; charset=utf-8"); headers.set("cache-control", "no-store");
    return new Response(script, { headers });
  } catch { return installerOriginUnavailable(); }
}

export function installerOriginUnavailable(): Response {
  return new Response("hosted installer is unavailable for this request origin", { status: 421, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
}
export function publicInstallerHeaders(contentType: string): Headers {
  return new Headers({ "content-type": contentType, "cache-control": "public, max-age=300", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "permissions-policy": "geolocation=(), microphone=(), camera=()" });
}
