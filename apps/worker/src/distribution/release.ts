import type { RunnerReleaseDescriptor, RunnerReleaseEnvironment, DevelopmentReleaseDependencies, DevelopmentReleaseRefreshScheduler } from "../contracts/runner-release.js";
import { DEV_RELEASE_CACHE_MS, DEV_RELEASE_STALE_MS, DEV_RELEASE_REFRESH_BUDGET_MS, developmentDescriptor, usableCacheAge, isDevelopment, unavailableDevelopmentRelease, releaseGateDiagnostics, runnerReleaseDescriptor } from "../domain/release-selection.js";
import { DEV_RELEASE_DISCOVERY_URL, releaseFetch, boundedJson, readDevelopmentReleaseCache, writeDevelopmentReleaseCache } from "./release-io.js";

export type { RunnerReleaseDescriptor, RunnerReleaseEnvironment, ReleaseGateDiagnostics, DevelopmentReleaseCache, DevelopmentReleaseVerifier, DevelopmentReleaseDependencies, DevelopmentReleaseRefreshScheduler } from "../contracts/runner-release.js";
export { releaseGateDiagnostics, runnerReleaseDescriptor, createDevelopmentReleaseRuntime } from "../domain/release-selection.js";
export { verifyDevelopmentRunnerRelease } from "./release-io.js";

const FAILED_REFRESH_COOLDOWN_MS = 5_000;

/** One invocation owns its refresh I/O. The injected runtime owns values only. */
async function fetchDevelopmentRunnerRelease(dependencies: DevelopmentReleaseDependencies, sequence: number): Promise<RunnerReleaseDescriptor> {
  const { runtime, cache, now, verify } = dependencies;
  const deadline = AbortSignal.timeout(DEV_RELEASE_REFRESH_BUDGET_MS);
  const boundedFetch: typeof fetch = (input, init) => {
    deadline.throwIfAborted();
    const signal = init?.signal == null ? deadline : AbortSignal.any([deadline, init.signal]);
    return dependencies.fetch(input, { ...init, signal });
  };
  const response = await releaseFetch(DEV_RELEASE_DISCOVERY_URL, {
    method: "GET", redirect: "manual", cache: "no-store", credentials: "omit",
    headers: { accept: "application/vnd.github+json", "user-agent": "runmeshdev-release-discovery/1", "x-github-api-version": "2026-03-10" },
  }, boundedFetch);
  const releases = await boundedJson(response);
  if (!Array.isArray(releases)) throw new Error("development release discovery response is invalid");
  const candidates = releases.flatMap(value => { const descriptor = developmentDescriptor(value); return descriptor === undefined ? [] : [descriptor]; });
  candidates.sort((a, b) => Number(b.package_version.split("-dev.")[1]) - Number(a.package_version.split("-dev.")[1]));
  for (const descriptor of candidates) {
    try {
      await verify(descriptor, boundedFetch);
      deadline.throwIfAborted();
      const verifiedAtMs = now();
      // An older request finishing late must not roll back a newer committed
      // refresh or extend the newer descriptor's original verification time.
      if (sequence < runtime.committed_sequence) {
        const current = runtime.cached;
        if (current !== undefined && usableCacheAge(current.verified_at_ms, verifiedAtMs, DEV_RELEASE_STALE_MS)) return current.descriptor;
        return descriptor;
      }
      runtime.committed_sequence = sequence;
      runtime.cached = { expires_at_ms: verifiedAtMs + DEV_RELEASE_CACHE_MS, verified_at_ms: verifiedAtMs, descriptor };
      runtime.next_refresh_at_ms = verifiedAtMs + DEV_RELEASE_CACHE_MS;
      await writeDevelopmentReleaseCache(cache, descriptor, verifiedAtMs);
      return descriptor;
    } catch { /* A malformed or unverifiable prerelease is never advertised. */ }
  }
  throw new Error("no immutable signed development Runner release is available");
}

function refreshDevelopmentRunnerRelease(dependencies: DevelopmentReleaseDependencies, sequence: number): Promise<RunnerReleaseDescriptor> {
  if (sequence !== dependencies.runtime.refresh_sequence) return Promise.reject(new Error("development release refresh temporarily unavailable"));
  // Cache I/O may have consumed the original reservation. Renew only while
  // still owning it, immediately before the request-owned network budget starts.
  dependencies.runtime.next_refresh_at_ms = dependencies.now() + DEV_RELEASE_REFRESH_BUDGET_MS;
  return fetchDevelopmentRunnerRelease(dependencies, sequence).catch(error => {
    // A delayed failure must not shorten a newer request's reservation.
    if (sequence === dependencies.runtime.refresh_sequence) dependencies.runtime.next_refresh_at_ms = dependencies.now() + FAILED_REFRESH_COOLDOWN_MS;
    throw error;
  });
}

/** Production and tests execute this same path with explicit state and ports. */
export async function discoverDevelopmentRunnerRelease(dependencies: DevelopmentReleaseDependencies, scheduleRefresh?: DevelopmentReleaseRefreshScheduler): Promise<RunnerReleaseDescriptor> {
  const { runtime, cache, now: clock } = dependencies;
  let now = clock();
  const memory = runtime.cached;
  if (memory !== undefined && memory.expires_at_ms > now && usableCacheAge(memory.verified_at_ms, now, DEV_RELEASE_STALE_MS)) return memory.descriptor;
  if (now < runtime.next_refresh_at_ms) {
    if (memory !== undefined && usableCacheAge(memory.verified_at_ms, now, DEV_RELEASE_STALE_MS)) return memory.descriptor;
    throw new Error("development release refresh temporarily unavailable");
  }
  // Reserve before cache I/O so concurrent cold requests cannot each read the
  // Registry and launch a complete public GitHub discovery/verification chain.
  // The lease expires if its request disappears; no I/O promise crosses requests.
  const sequence = ++runtime.refresh_sequence;
  runtime.next_refresh_at_ms = now + DEV_RELEASE_REFRESH_BUDGET_MS;
  const cached = await readDevelopmentReleaseCache(cache);
  now = clock(); // Storage latency cannot extend the original verification deadline.
  // Another request may have committed a refresh while this read was pending.
  const afterRead = runtime.cached;
  if (afterRead !== undefined && afterRead.expires_at_ms > now && usableCacheAge(afterRead.verified_at_ms, now, DEV_RELEASE_STALE_MS)) return afterRead.descriptor;
  if (sequence !== runtime.refresh_sequence) {
    if (afterRead !== undefined && usableCacheAge(afterRead.verified_at_ms, now, DEV_RELEASE_STALE_MS)) return afterRead.descriptor;
    if (cached !== undefined && usableCacheAge(cached.verified_at_ms, now, DEV_RELEASE_STALE_MS)) return cached.descriptor;
    throw new Error("development release refresh temporarily unavailable");
  }
  const cacheAgeMs = cached === undefined || cached.verified_at_ms > now ? Number.POSITIVE_INFINITY : now - cached.verified_at_ms;
  if (cached !== undefined && cacheAgeMs <= DEV_RELEASE_CACHE_MS) {
    runtime.cached = { expires_at_ms: cached.verified_at_ms + DEV_RELEASE_CACHE_MS, verified_at_ms: cached.verified_at_ms, descriptor: cached.descriptor };
    if (sequence === runtime.refresh_sequence) runtime.next_refresh_at_ms = cached.verified_at_ms + DEV_RELEASE_CACHE_MS;
    return cached.descriptor;
  }
  if (cached !== undefined && cacheAgeMs < DEV_RELEASE_STALE_MS && scheduleRefresh !== undefined) {
    runtime.cached = { expires_at_ms: Math.min(now + DEV_RELEASE_CACHE_MS, cached.verified_at_ms + DEV_RELEASE_STALE_MS), verified_at_ms: cached.verified_at_ms, descriptor: cached.descriptor };
    const refresh = refreshDevelopmentRunnerRelease(dependencies, sequence).then(() => undefined).catch(() => undefined);
    try { scheduleRefresh(refresh); } catch { /* Original hard expiry still applies. */ }
    return cached.descriptor;
  }
  try { return await refreshDevelopmentRunnerRelease(dependencies, sequence); }
  catch (error) {
    const completedAtMs = clock();
    const current = runtime.cached;
    if (current !== undefined && usableCacheAge(current.verified_at_ms, completedAtMs, DEV_RELEASE_STALE_MS)) {
      runtime.cached = { ...current, expires_at_ms: Math.min(completedAtMs + DEV_RELEASE_CACHE_MS, current.verified_at_ms + DEV_RELEASE_STALE_MS) };
      return current.descriptor;
    }
    if (cached !== undefined && usableCacheAge(cached.verified_at_ms, completedAtMs, DEV_RELEASE_STALE_MS)) {
      runtime.cached = { expires_at_ms: Math.min(now + DEV_RELEASE_CACHE_MS, cached.verified_at_ms + DEV_RELEASE_STALE_MS), verified_at_ms: cached.verified_at_ms, descriptor: cached.descriptor };
      return cached.descriptor;
    }
    throw error;
  }
}

/** Development is dev-only. Stable stays source-pinned and network-free. */
export async function resolveRunnerReleaseDescriptor(env: RunnerReleaseEnvironment, dependencies: DevelopmentReleaseDependencies, scheduleRefresh?: DevelopmentReleaseRefreshScheduler): Promise<RunnerReleaseDescriptor> {
  if (!isDevelopment(env)) return runnerReleaseDescriptor(env);
  const gate = releaseGateDiagnostics(env);
  if (!gate.acknowledgement_matches_fixed_release || !gate.canonical_public_origin_configured || !gate.test_mode_disabled) return unavailableDevelopmentRelease();
  try { return await discoverDevelopmentRunnerRelease(dependencies, scheduleRefresh); }
  catch { return unavailableDevelopmentRelease(); }
}

export async function resolveDevelopmentRunnerRelease(env: RunnerReleaseEnvironment, dependencies: DevelopmentReleaseDependencies, scheduleRefresh?: DevelopmentReleaseRefreshScheduler): Promise<RunnerReleaseDescriptor> {
  if (!isDevelopment(env)) return unavailableDevelopmentRelease();
  return resolveRunnerReleaseDescriptor(env, dependencies, scheduleRefresh);
}
