import { lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { isTerminalRunnerUpdate } from "@aloneio/runmesh-protocol";
import { ProfileStore, type RunnerProfile } from "../profile.js";
import type { ServiceMode, ServicePlatform } from "../service.js";
import { createCloudMaintenance } from "./cloud.js";
import { UpdateFailure } from "./contracts.js";
import { UpdateCoordinator } from "./coordinator.js";
import { ManagedInstallationPointer } from "./installation.js";
import { acquireInstallationLock } from "./installation-lock.js";
import { assertManagerDirectory, FileUpdateJournal, loadManagerId } from "./journal.js";
import { inspectLocalJobs } from "./job-drain.js";
import { maintenanceManagerLayout } from "./manager-install.js";
import { createNativeServiceMaintenance } from "./native-service.js";
import { stageRunnerRelease } from "./release-stager.js";

export interface MaintenanceAgentOptions {
  readonly profilePath: string;
  readonly installRoot: string;
  readonly platform?: ServicePlatform;
  readonly mode?: ServiceMode;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly onError?: (code: string) => void;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolveSleep => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolveSleep(); };
    const timer = setTimeout(finish, milliseconds); signal.addEventListener("abort", finish, { once: true });
  });
}

/** This entry point can only run from the copied manager runtime and bundle.
 * A selected legacy Runner package therefore cannot replace its updater. */
export async function runMaintenanceAgent(options: MaintenanceAgentOptions): Promise<void> {
  const layout = maintenanceManagerLayout(options);
  const equal = (left: string, right: string) => layout.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
  await assertManagerDirectory(layout.layout.installRoot);
  await assertManagerDirectory(layout.managerRoot);
  await assertManagerDirectory(join(layout.managerRoot, "runtime"));
  for (const path of [layout.runtimePath, layout.bundlePath]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !equal(await realpath(path), path) || (process.platform !== "win32" && ((info.mode & 0o022) !== 0 || info.uid !== process.getuid?.()))) throw new UpdateFailure("invalid_installation");
  }
  if (!equal(await realpath(process.execPath), layout.runtimePath) || process.argv[1] === undefined || !equal(await realpath(process.argv[1]), layout.bundlePath)) throw new UpdateFailure("invalid_installation");
  const store = new ProfileStore({ filePath: options.profilePath, platform: layout.platform, enforceServiceOwnership: layout.mode === "system" });
  const initial = await store.load();
  if (initial === undefined) throw new UpdateFailure("invalid_installation");
  const profile = async (): Promise<RunnerProfile> => {
    const current = await store.load();
    if (current === undefined || current.runner_id !== initial.runner_id || current.server_url !== initial.server_url) throw new UpdateFailure("invalid_installation");
    return current;
  };
  const abort = new AbortController();
  const signal = options.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, options.signal]);
  const stop = () => abort.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const directory = join(layout.managerRoot, "state"); await assertManagerDirectory(directory, true);
  const journal = new FileUpdateJournal(directory);
  const cloud = createCloudMaintenance({ profile, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  let lastError: string | undefined;
  try {
    while (!signal.aborted) {
      let lease: Awaited<ReturnType<typeof acquireInstallationLock>>;
      try {
        const saved = await journal.load();
        const offered = saved === undefined ? await cloud.poll() : undefined;
        const pending = offered?.operation;
        if (saved !== undefined || (pending !== undefined && pending !== null && !isTerminalRunnerUpdate(pending.state))) {
          lease = await acquireInstallationLock(layout.mode, layout.layout.installRoot);
          if (lease !== undefined) {
            const managerId = await loadManagerId(directory);
            const held = lease;
            const coordinator = new UpdateCoordinator({ managerId, cloud, journal,
              recoveryIdentity: async () => {
                const current = await profile();
                return createHash("sha256").update(JSON.stringify([resolve(layout.layout.installRoot), current.runner_id, current.server_url, current.token])).digest("hex");
              },
              installation: new ManagedInstallationPointer(layout.layout.installRoot),
              service: createNativeServiceMaintenance(options),
              stage: (target, operationId) => stageRunnerRelease(target, { installRoot: layout.layout.installRoot, operationId, runtimePath: layout.runtimePath, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) }),
              jobs: () => inspectLocalJobs(layout.layout.stateRoot), signal,
              assertInstallationLock: () => held.assertHeld(),
            });
            await coordinator.runOnce();
          }
        }
        lastError = undefined;
      } catch (error) {
        const code = error instanceof UpdateFailure ? error.code : "maintenance_unavailable";
        if (code !== lastError) (options.onError ?? (value => process.stderr.write(`Runner maintenance: ${value}\n`)))(code);
        lastError = code;
      } finally { await lease?.release().catch(() => undefined); }
      // Idle polling is read-only and jittered; active phase writes occur only
      // on transitions, never once per poll or when no operation is offered.
      await sleep(30_000 + Math.floor(Math.random() * 30_001), signal);
    }
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
