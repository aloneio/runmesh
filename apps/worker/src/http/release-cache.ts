import type { DevelopmentReleaseDependencies, DevelopmentReleaseRuntime, DevelopmentReleaseCache } from "../contracts/runner-release.js";
import { createDevelopmentReleaseRuntime } from "../domain/release-selection.js";
import { verifyDevelopmentRunnerRelease } from "../distribution/release-io.js";
import { registryRequest } from "../platform/control-plane.js";
import { boundedJsonResponse } from "../bounded-json.js";
import type { WorkerEnv } from "../platform/env.js";

const VERIFIED_DEV_RELEASE_PATH = "/distribution/dev-runner-release";
const REGISTRY_CACHE_TIMEOUT_MS = 5_000;
const MAX_CACHE_RECORD_BYTES = 512 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Persistence is best effort; a stalled Registry must not hold a verified
 * release response open. Never retry a write with an unknown outcome. */
async function persistReleaseCache(env: WorkerEnv, value: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = async (): Promise<void> => {
    const response = await registryRequest(env, VERIFIED_DEV_RELEASE_PATH, "POST", JSON.stringify(value), controller.signal);
    void response.body?.cancel().catch(() => undefined);
    if (controller.signal.aborted || response.status !== 204) throw new Error("development release registry cache write failed");
  };
  try {
    await Promise.race([write(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("development release registry cache write timed out")); }, REGISTRY_CACHE_TIMEOUT_MS);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}

/** HTTP composition adapter for the globally persisted descriptor that has
 * already passed release.ts Ed25519 verification. The distribution layer
 * revalidates every cached field before use. */
export function registryDevelopmentReleaseCache(env: WorkerEnv): DevelopmentReleaseCache {
  return {
    async match(request: Request): Promise<Response | undefined> {
      const receipt = await boundedJsonResponse(signal => registryRequest(env, VERIFIED_DEV_RELEASE_PATH, "GET", "", signal), REGISTRY_CACHE_TIMEOUT_MS, MAX_CACHE_RECORD_BYTES, request.signal);
      return receipt?.status === 200 && receipt.value !== undefined ? Response.json(receipt.value) : undefined;
    },
    async put(_request: Request, response: Response): Promise<void> {
      let value: unknown;
      try { value = await response.json(); } catch { throw new Error("development release cache record is invalid"); }
      if (!record(value)) throw new Error("development release cache record is invalid");
      await persistReleaseCache(env, value);
    },
  };
}

// One value-only runtime per Registry binding, shared by every HTTP surface.
const scopedRuntimes = new WeakMap<object, DevelopmentReleaseRuntime>();
export function developmentReleaseDependencies(env: WorkerEnv): DevelopmentReleaseDependencies {
  let runtime = scopedRuntimes.get(env.REGISTRY);
  if (runtime === undefined) { runtime = createDevelopmentReleaseRuntime(); scopedRuntimes.set(env.REGISTRY, runtime); }
  // Native workerd fetch must not receive the dependency object as its receiver.
  return { fetch: (input, init) => fetch(input, init), verify: verifyDevelopmentRunnerRelease, cache: registryDevelopmentReleaseCache(env), now: () => Date.now(), runtime };
}
