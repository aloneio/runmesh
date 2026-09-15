import { access } from "node:fs/promises";
import type { CliDependencies } from "./contracts.js";
import { currentServicePlatform } from "../service.js";
import { hostServiceManifestFilesystem } from "../service.js";
import { isManagedService } from "../service.js";
import { managedServiceManifestFromContent } from "../service.js";
import type { ParsedCommand } from "./contracts.js";
import { parseRunnerArgs } from "../config.js";
import { profileExecutionMode } from "../profile.js";
import { ProfileStore } from "../profile.js";
import type { RawRunnerOptions } from "../config.js";
import { renderService } from "../service.js";
import { rm } from "node:fs/promises";
import { RunnerConnection } from "../connection.js";
import { serviceLayout } from "../service.js";
import type { ServiceManifestFilesystem } from "../service.js";
import type { ServicePlatform } from "../service.js";
import { validateRunnerConfig } from "../config.js";

export async function start(parsed: ParsedCommand, store: ProfileStore, error: (line: string) => void, dependencies: CliDependencies): Promise<void> {
  const raw = parseRunnerArgs(parsed.passthrough);
  const profilePath = typeof parsed.values.profilePath === "string" ? parsed.values.profilePath : undefined;
  const profileStore = profilePath === undefined
    ? store
    : new ProfileStore({ filePath: profilePath, ...(dependencies.servicePlatform === undefined ? {} : { platform: dependencies.servicePlatform }) });
  const profile = await profileStore.load();
  // A system Runner must not consume a canonical profile owned by an
  // untrusted account/group.  This is checked after parsing execution_mode so
  // dedicated_user and privileged_host receive their distinct root:group
  // contracts; user-level foreground starts intentionally skip it.
  if (parsed.values.user !== true && profile !== undefined
    && (profile.execution_mode === "dedicated_user" || profile.execution_mode === "privileged_host")) {
    // A managed system manifest may use a custom dedicated group.  Carry the
    // identity from that manifest into the profile ownership check instead of
    // assuming the built-in `runmesh` group.
    const serviceGroup = await serviceGroupForManagedProfile(profileStore, dependencies.servicePlatform, dependencies.serviceFilesystem);
    await profileStore.assertServiceOwnership(profile.execution_mode, serviceGroup);
  }
  if ((raw.workspaces?.length ?? 0) > 0) throw new Error("Workspace configuration is centrally managed through the Runmesh Admin Panel; --workspace is not supported.");
  const server = raw.server ?? profile?.server_url;
  const token = raw.token ?? process.env.RUNMESH_RUNNER_TOKEN ?? profile?.token;
  const runnerId = raw.runnerId ?? profile?.runner_id;
  const maxConcurrentJobs = raw.maxConcurrentJobs ?? profile?.max_concurrent_jobs;
  const options: RawRunnerOptions = {
    ...(server === undefined ? {} : { server }),
    ...(token === undefined ? {} : { token }),
    ...(runnerId === undefined ? {} : { runnerId }),
    ...(raw.insecureLocal === true || profile?.insecure_local === true ? { insecureLocal: true } : {}),
    ...(maxConcurrentJobs === undefined ? {} : { maxConcurrentJobs }),
    ...(raw.stateDir === undefined ? {} : { stateDir: raw.stateDir }),
    // Test controls are retained only in the foreground compatible start path, never stored.
    ...(raw.disconnectAfterMs === undefined ? {} : { disconnectAfterMs: raw.disconnectAfterMs }),
    ...(raw.disconnectControlFile === undefined ? {} : { disconnectControlFile: raw.disconnectControlFile }),
    workspaces: [],
  };
  const config = await validateRunnerConfig(options);
  if (dependencies.startRunner !== undefined) return dependencies.startRunner(config);
  // A user-level foreground service is never allowed to inherit a
  // privileged_host claim from a copied or manually edited system profile.
  // The process is running under the interactive account, so report the
  // effective user-service contract as dedicated_user and let OS validation
  // fail closed for any host-wide workspace it cannot actually access.
  const executionMode = parsed.values.user === true ? "dedicated_user" as const : profileExecutionMode(profile);
  const runner = new RunnerConnection({
    config,
    onStateChange: (state) => error(`runner ${config.runnerId}: ${state}`),
    ...(executionMode === "dedicated_user" || executionMode === "privileged_host" ? { executionMode } : {}),
  });
  if (config.disconnectControlFile !== undefined) installDisconnectControl(runner, config.disconnectControlFile);
  const stop = (): void => runner.stop();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  // Local E2E transport control; it has no persisted profile representation.
  process.on("SIGUSR1", () => runner.disconnectForTest());
  await runner.start();
}

/** Read the managed system definition used by a service-launched `start` and
 * return its dedicated group, if one was explicitly configured.  The profile
 * format intentionally does not duplicate service-account metadata; the
 * signed/hashed native manifest is the source of truth for this local check.
 */
async function serviceGroupForManagedProfile(store: ProfileStore, platform: ServicePlatform | undefined, filesystem: ServiceManifestFilesystem | undefined): Promise<string | undefined> {
  const targetPlatform = platform ?? currentServicePlatform();
  const layout = serviceLayout({ platform: targetPlatform, mode: "system" });
  let content: string | undefined;
  try { content = await (filesystem ?? hostServiceManifestFilesystem).read(layout.manifestPath); }
  catch { return undefined; }
  if (content === undefined || !isManagedService(content)) return undefined;
  try {
    const base = renderService({ platform: targetPlatform, mode: "system", executionMode: "dedicated_user", profilePath: store.filePath });
    return managedServiceManifestFromContent(base, content, "dedicated_user").serviceGroup;
  } catch { return undefined; }
}

function installDisconnectControl(runner: RunnerConnection, file: string): void { let busy = false; const interval = setInterval(async () => { if (busy) return; busy = true; try { await access(file); await rm(file, { force: true }); runner.disconnectForTest(); } catch { /* absent */ } finally { busy = false; } }, 50); interval.unref(); }
