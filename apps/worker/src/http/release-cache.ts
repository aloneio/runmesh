import type { DevelopmentReleaseDependencies, DevelopmentReleaseRuntime } from "../contracts/runner-release.js";
import { createDevelopmentReleaseRuntime } from "../domain/release-selection.js";
import { defaultDevelopmentReleaseCache, verifyDevelopmentRunnerRelease } from "../distribution/release-io.js";
import type { DevelopmentReleaseCache } from "../distribution/release.js";
import { registryGet, registryPost } from "../platform/control-plane.js";
import type { WorkerEnv } from "../platform/env.js";

const VERIFIED_DEV_RELEASE_PATH = "/distribution/dev-runner-release";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** HTTP composition adapter for the globally persisted descriptor that has
 * already passed release.ts Ed25519 verification. The distribution layer
 * revalidates every cached field before use. */
export function registryDevelopmentReleaseCache(env: WorkerEnv): DevelopmentReleaseCache {
  return {
    async match(): Promise<Response | undefined> {
      const response = await registryGet(env, VERIFIED_DEV_RELEASE_PATH);
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return undefined; }
      return response;
    },
    async put(_request: Request, response: Response): Promise<void> {
      let value: unknown;
      try { value = await response.json(); } catch { throw new Error("development release cache record is invalid"); }
      if (!record(value)) throw new Error("development release cache record is invalid");
      const stored = await registryPost(env, VERIFIED_DEV_RELEASE_PATH, value);
      if (!stored.ok) { await stored.body?.cancel().catch(() => undefined); throw new Error("development release registry cache write failed"); }
      await stored.body?.cancel().catch(() => undefined);
    },
  };
}

// One value cache per Worker isolate. Requests never share an unfinished I/O promise.
const releaseRuntime = createDevelopmentReleaseRuntime();
const scopedRuntimes = new WeakMap<object, DevelopmentReleaseRuntime>();
export function developmentReleaseDependencies(cache?: DevelopmentReleaseCache | null, scope?: object): DevelopmentReleaseDependencies {
  let runtime = scope === undefined ? releaseRuntime : scopedRuntimes.get(scope);
  if (runtime === undefined) { runtime = createDevelopmentReleaseRuntime(); scopedRuntimes.set(scope!, runtime); }
  // Native workerd fetch must not receive the dependency object as its receiver.
  return { fetch: (input, init) => fetch(input, init), verify: verifyDevelopmentRunnerRelease, cache: cache === null ? undefined : cache ?? defaultDevelopmentReleaseCache(), now: () => Date.now(), runtime };
}
