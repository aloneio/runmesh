import type { RunnerReleaseDescriptor, RunnerReleaseEnvironment, DevelopmentReleaseDependencies, DevelopmentReleaseRefreshScheduler, CachedDevelopmentReleaseRecord, DevelopmentReleaseFailure } from "../contracts/runner-release.js";
import { DEV_RELEASE_CACHE_MS, DEV_RELEASE_STALE_MS, DEV_RELEASE_REFRESH_BUDGET_MS, compareDevelopmentReleaseVersions, developmentDescriptor, usableCacheAge, isDevelopment, unavailableDevelopmentRelease, releaseGateDiagnostics, runnerReleaseDescriptor } from "../domain/release-selection.js";
import { DEV_RELEASE_DISCOVERY_URL, releaseFetch, releaseFetchWithinDeadline, boundedJson, readDevelopmentReleaseCache, writeDevelopmentReleaseCache, DevelopmentReleaseError, developmentReleaseFailure } from "./release-io.js";

export type { RunnerReleaseDescriptor, RunnerReleaseEnvironment, ReleaseGateDiagnostics, DevelopmentReleaseCache, DevelopmentReleaseVerifier, DevelopmentReleaseDependencies, DevelopmentReleaseRefreshScheduler } from "../contracts/runner-release.js";
export { releaseGateDiagnostics, runnerReleaseDescriptor, createDevelopmentReleaseRuntime } from "../domain/release-selection.js";
export { verifyDevelopmentRunnerRelease } from "./release-io.js";

const FAILED_REFRESH_COOLDOWN_MS = 5_000;
const COLD_REFRESH_POLL_MS = 100;
const FAILED_REFRESH_RECOVERY_MS = 1_000;
type VerifiedReleaseRecord = Pick<CachedDevelopmentReleaseRecord, "verified_at_ms" | "descriptor">;

function newestUsableRelease(now: number, ...records: (VerifiedReleaseRecord | undefined)[]): VerifiedReleaseRecord | undefined {
  // Match Registry's version ordering, then verification time for the same
  // version. Filtering first prevents a future record from hiding valid work.
  return records.filter((value): value is VerifiedReleaseRecord => value !== undefined && usableCacheAge(value.verified_at_ms, now, DEV_RELEASE_STALE_MS))
    .sort((a, b) => compareDevelopmentReleaseVersions(b.descriptor.package_version, a.descriptor.package_version)
      || (a.descriptor.package_version === b.descriptor.package_version ? b.verified_at_ms - a.verified_at_ms : 0))[0];
}

/** Each caller owns its timer; only verified values cross request boundaries. */
async function waitForDevelopmentRelease(dependencies: DevelopmentReleaseDependencies, deadlineMs: number): Promise<RunnerReleaseDescriptor> {
  const { runtime, now: clock } = dependencies;
  let remainingMs = DEV_RELEASE_REFRESH_BUDGET_MS;
  for (;;) {
    const now = clock();
    const completed = runtime.cached;
    if (completed !== undefined && usableCacheAge(completed.verified_at_ms, now, DEV_RELEASE_STALE_MS)) return completed.descriptor;
    if (remainingMs <= 0 || now >= deadlineMs || now >= runtime.next_refresh_at_ms || runtime.failed_sequence === runtime.refresh_sequence) {
      throw new Error("development release refresh temporarily unavailable");
    }
    const delayMs = Math.min(COLD_REFRESH_POLL_MS, remainingMs, deadlineMs - now, runtime.next_refresh_at_ms - now);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    // Also bound waiting if an injected or wall clock does not advance.
    remainingMs -= delayMs;
  }
}

/** One invocation owns its refresh I/O. The injected runtime owns values only. */
async function fetchDevelopmentRunnerRelease(dependencies: DevelopmentReleaseDependencies, sequence: number, cached: CachedDevelopmentReleaseRecord | undefined,
  onDiscoveryFallback: (failure: DevelopmentReleaseFailure, retryAtMs?: number) => void): Promise<RunnerReleaseDescriptor> {
  const { runtime, cache, now, verify } = dependencies;
  const deadline = AbortSignal.timeout(DEV_RELEASE_REFRESH_BUDGET_MS);
  const boundedFetch = releaseFetchWithinDeadline(dependencies.fetch, deadline);
  let candidates: RunnerReleaseDescriptor[], revalidating = false;
  try {
    const response = await releaseFetch(DEV_RELEASE_DISCOVERY_URL, {
      method: "GET", redirect: "manual", cache: "no-store", credentials: "omit",
      headers: { accept: "application/vnd.github+json", "user-agent": "runmeshdev-release-discovery/1", "x-github-api-version": "2026-03-10" },
    }, boundedFetch);
    const releases = await boundedJson(response);
    if (!Array.isArray(releases)) throw new DevelopmentReleaseError("development release discovery response is invalid", { phase: "discovery", reason: "invalid_response" });
    candidates = releases.flatMap(value => { const descriptor = developmentDescriptor(value); return descriptor === undefined ? [] : [descriptor]; });
    candidates.sort((a, b) => compareDevelopmentReleaseVersions(b.package_version, a.package_version));
  } catch (error) {
    const failure = developmentReleaseFailure(error);
    const transient = failure.phase === "discovery" && (failure.reason === "network_error" || failure.reason === "timeout"
      || failure.reason === "http_error" && (failure.http_status === 403 || failure.http_status === 429 || Number(failure.http_status) >= 500));
    // Expiry removes permission to serve this record, not its value as a
    // previously discovered immutable tag. Only a complete new signature and
    // manifest verification may restore it, within this same refresh budget.
    if (!transient || cached === undefined || cached.verified_at_ms > now() || now() - cached.verified_at_ms < DEV_RELEASE_STALE_MS) throw error;
    deadline.throwIfAborted();
    candidates = [cached.descriptor];
    revalidating = true;
    onDiscoveryFallback(failure, error instanceof DevelopmentReleaseError ? error.retry_at_ms : undefined);
  }
  let candidateFailure: DevelopmentReleaseFailure | undefined;
  for (const descriptor of candidates) {
    try {
      await verify(descriptor, boundedFetch);
      deadline.throwIfAborted();
      const verifiedAtMs = now();
      // An older request finishing late must not roll back a newer committed
      // refresh or extend the newer descriptor's original verification time.
      const current = runtime.cached;
      if (sequence < runtime.committed_sequence) {
        if (current !== undefined && usableCacheAge(current.verified_at_ms, verifiedAtMs, DEV_RELEASE_STALE_MS)) return current.descriptor;
        return descriptor;
      }
      if (current !== undefined && usableCacheAge(current.verified_at_ms, verifiedAtMs, DEV_RELEASE_STALE_MS)
        && compareDevelopmentReleaseVersions(current.descriptor.package_version, descriptor.package_version) >= 0 && current.descriptor.package_version !== descriptor.package_version) return current.descriptor;
      runtime.committed_sequence = sequence;
      runtime.cached = { expires_at_ms: verifiedAtMs + DEV_RELEASE_CACHE_MS, verified_at_ms: verifiedAtMs, descriptor };
      runtime.next_refresh_at_ms = verifiedAtMs + DEV_RELEASE_CACHE_MS;
      await writeDevelopmentReleaseCache(cache, descriptor, verifiedAtMs);
      if (revalidating) {
        // Registry rejects an older version even if its re-verification finished
        // later. Observe that winner before returning or retaining a local
        // fallback that could otherwise hide another isolate's newer release.
        // Signature/network work shares the original 20s deadline; this final
        // cache convergence uses the same 1s bound as failed-refresh recovery,
        // including when persistence outlasts that network deadline.
        const persisted = await readDevelopmentReleaseCache(cache, FAILED_REFRESH_RECOVERY_MS);
        const completedAtMs = now();
        const winner = newestUsableRelease(completedAtMs, runtime.cached, persisted);
        if (winner !== undefined && compareDevelopmentReleaseVersions(winner.descriptor.package_version, descriptor.package_version) > 0) {
          runtime.cached = { expires_at_ms: Math.min(completedAtMs + DEV_RELEASE_CACHE_MS, winner.verified_at_ms + DEV_RELEASE_STALE_MS), verified_at_ms: winner.verified_at_ms, descriptor: winner.descriptor };
          return winner.descriptor;
        }
      }
      // Persistence also yields. A newer refresh may commit while this write
      // settles or while the bounded Registry readback is unavailable.
      const completed = newestUsableRelease(now(), runtime.cached);
      return completed !== undefined && compareDevelopmentReleaseVersions(completed.descriptor.package_version, descriptor.package_version) >= 0
        ? completed.descriptor : descriptor;
    } catch (error) {
      const failure = developmentReleaseFailure(error, "verification");
      if (deadline.aborted) throw new DevelopmentReleaseError("no immutable signed development Runner release is available", { phase: failure.phase, reason: "timeout" }, error instanceof DevelopmentReleaseError ? error.retry_at_ms : undefined);
      // Other tags use the same release host. Changing candidates must not
      // bypass that host's explicit retry window during this refresh.
      if (error instanceof DevelopmentReleaseError && error.retry_at_ms !== undefined && error.retry_at_ms > now()) throw error;
      candidateFailure ??= failure;
    }
  }
  throw new DevelopmentReleaseError("no immutable signed development Runner release is available", candidateFailure ?? { phase: "discovery", reason: "no_candidate" });
}

/** A cold miss may precede another isolate's successful verification. */
async function recoverDevelopmentRelease(dependencies: DevelopmentReleaseDependencies, budgetMs: number, cached?: CachedDevelopmentReleaseRecord): Promise<VerifiedReleaseRecord | undefined> {
  const deadline = performance.now() + budgetMs;
  let remainingMs = budgetMs, pollMs = COLD_REFRESH_POLL_MS;
  while (remainingMs > 0) {
    const persisted = await readDevelopmentReleaseCache(dependencies.cache, Math.min(FAILED_REFRESH_RECOVERY_MS, Math.ceil(remainingMs)));
    const now = dependencies.now();
    const recovered = newestUsableRelease(now, dependencies.runtime.cached, persisted, cached);
    if (recovered !== undefined || dependencies.cache === undefined) return recovered;
    remainingMs = Math.min(remainingMs, Math.max(0, Math.ceil(deadline - performance.now())));
    const delayMs = Math.min(pollMs, remainingMs);
    if (delayMs === 0) break;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    pollMs = Math.min(pollMs * 2, FAILED_REFRESH_RECOVERY_MS);
    // Bound retries even when a test or host clock stops advancing.
    remainingMs = Math.min(remainingMs - delayMs, Math.max(0, Math.ceil(deadline - performance.now())));
  }
  return undefined;
}

async function refreshDevelopmentRunnerRelease(dependencies: DevelopmentReleaseDependencies, sequence: number, cached?: CachedDevelopmentReleaseRecord): Promise<RunnerReleaseDescriptor> {
  const { runtime, now: clock } = dependencies;
  if (sequence !== runtime.refresh_sequence) throw new Error("development release refresh temporarily unavailable");
  // Cache I/O may have consumed the original reservation. Renew only while
  // still owning it, immediately before the request-owned network budget starts.
  runtime.next_refresh_at_ms = clock() + DEV_RELEASE_REFRESH_BUDGET_MS;
  const refreshStartedAtMs = performance.now();
  let discoveryFailure: DevelopmentReleaseFailure | undefined;
  let discoveryRetryAtMs: number | undefined;
  try {
    const descriptor = await fetchDevelopmentRunnerRelease(dependencies, sequence, cached, (failure, retryAtMs) => { discoveryFailure = failure; discoveryRetryAtMs = retryAtMs; });
    if (sequence === runtime.refresh_sequence && discoveryRetryAtMs !== undefined) runtime.next_refresh_at_ms = Math.max(runtime.next_refresh_at_ms, discoveryRetryAtMs);
    // A successfully reverified tag restores availability without erasing the
    // discovery outage that required it. Diagnostics cannot change the result.
    if (discoveryFailure !== undefined) { try { dependencies.onRefreshFailure?.({ ...discoveryFailure, recovery: "reverified" }); } catch { /* observations remain local */ } }
    return descriptor;
  }
  catch (error) {
    // Recovery belongs to the refresh: waiting requests must not observe a
    // terminal failure while its cross-isolate cache read is still pending.
    // A cold isolate may fail before another isolate finishes its signature
    // verification. Use the remaining refresh budget, with bounded storage
    // recovery after a spent deadline; usable stale values still return promptly.
    const recoveryBudgetMs = newestUsableRelease(clock(), runtime.cached, cached) === undefined
      ? Math.max(FAILED_REFRESH_RECOVERY_MS, DEV_RELEASE_REFRESH_BUDGET_MS - (performance.now() - refreshStartedAtMs))
      : FAILED_REFRESH_RECOVERY_MS;
    const observed = await recoverDevelopmentRelease(dependencies, recoveryBudgetMs, cached);
    const completedAtMs = clock();
    // An asynchronous recovery must not replace a newer committed value.
    const recovered = newestUsableRelease(completedAtMs, runtime.cached, observed, cached);
    // A delayed failure must not shorten a newer request's reservation.
    if (sequence === runtime.refresh_sequence) {
      runtime.failed_sequence = sequence;
      runtime.next_refresh_at_ms = Math.max(completedAtMs + FAILED_REFRESH_COOLDOWN_MS,
        discoveryRetryAtMs ?? 0, error instanceof DevelopmentReleaseError ? error.retry_at_ms ?? 0 : 0);
    }
    // Only the refresh owner reports after recovery; waiters and HTTP retries
    // share this outcome without producing duplicate diagnostics.
    const actualFailure = developmentReleaseFailure(error);
    const reportedFailure: DevelopmentReleaseFailure = discoveryFailure === undefined ? actualFailure : { ...discoveryFailure, recovery: "failed",
      recovery_phase: actualFailure.phase, recovery_reason: actualFailure.reason,
      ...(actualFailure.http_status === undefined ? {} : { recovery_http_status: actualFailure.http_status }) };
    try { dependencies.onRefreshFailure?.(reportedFailure); } catch { /* Diagnostics cannot change release availability. */ }
    if (recovered !== undefined) {
      runtime.cached = { expires_at_ms: Math.min(completedAtMs + DEV_RELEASE_CACHE_MS, recovered.verified_at_ms + DEV_RELEASE_STALE_MS), verified_at_ms: recovered.verified_at_ms, descriptor: recovered.descriptor };
      return recovered.descriptor;
    }
    throw error;
  }
}

/** Production and tests execute this same path with explicit state and ports. */
export async function discoverDevelopmentRunnerRelease(dependencies: DevelopmentReleaseDependencies, scheduleRefresh?: DevelopmentReleaseRefreshScheduler): Promise<RunnerReleaseDescriptor> {
  const { runtime, cache, now: clock } = dependencies;
  let now = clock();
  const waitDeadlineMs = now + DEV_RELEASE_REFRESH_BUDGET_MS;
  const memory = runtime.cached;
  if (memory !== undefined && memory.expires_at_ms > now && usableCacheAge(memory.verified_at_ms, now, DEV_RELEASE_STALE_MS)) return memory.descriptor;
  if (now < runtime.next_refresh_at_ms) {
    if (memory !== undefined && usableCacheAge(memory.verified_at_ms, now, DEV_RELEASE_STALE_MS)) return memory.descriptor;
    // Another request may still be loading the first persisted value. Its
    // refresh lease limits public discovery, not reads of verified storage.
    // Keep this I/O request-owned and do not change the owner's reservation.
    const persisted = await readDevelopmentReleaseCache(cache);
    now = clock();
    const completed = runtime.cached;
    if (completed !== undefined && usableCacheAge(completed.verified_at_ms, now, DEV_RELEASE_STALE_MS)) return completed.descriptor;
    if (persisted !== undefined && usableCacheAge(persisted.verified_at_ms, now, DEV_RELEASE_STALE_MS)) return persisted.descriptor;
    return waitForDevelopmentRelease(dependencies, waitDeadlineMs);
  }
  // Reserve before cache I/O so concurrent cold requests cannot each launch
  // a complete public GitHub discovery/verification chain.
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
    return waitForDevelopmentRelease(dependencies, waitDeadlineMs);
  }
  const cacheAgeMs = cached === undefined || cached.verified_at_ms > now ? Number.POSITIVE_INFINITY : now - cached.verified_at_ms;
  if (cached !== undefined && cacheAgeMs <= DEV_RELEASE_CACHE_MS) {
    runtime.cached = { expires_at_ms: cached.verified_at_ms + DEV_RELEASE_CACHE_MS, verified_at_ms: cached.verified_at_ms, descriptor: cached.descriptor };
    if (sequence === runtime.refresh_sequence) runtime.next_refresh_at_ms = cached.verified_at_ms + DEV_RELEASE_CACHE_MS;
    return cached.descriptor;
  }
  if (cached !== undefined && cacheAgeMs < DEV_RELEASE_STALE_MS && scheduleRefresh !== undefined) {
    runtime.cached = { expires_at_ms: Math.min(now + DEV_RELEASE_CACHE_MS, cached.verified_at_ms + DEV_RELEASE_STALE_MS), verified_at_ms: cached.verified_at_ms, descriptor: cached.descriptor };
    const refresh = refreshDevelopmentRunnerRelease(dependencies, sequence, cached).then(() => undefined).catch(() => undefined);
    try { scheduleRefresh(refresh); } catch { /* Original hard expiry still applies. */ }
    return cached.descriptor;
  }
  return refreshDevelopmentRunnerRelease(dependencies, sequence, cached);
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
