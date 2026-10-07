import type { CachedDevelopmentReleaseRecord, DevelopmentReleaseCache, DevelopmentReleaseRefreshScheduler, DevelopmentReleaseVerifier, DevelopmentReleaseDependencies, RunnerReleaseEnvironment } from "../src/contracts/runner-release.js";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import { developmentReleaseDependencies, registryDevelopmentReleaseCache } from "../src/http/release-cache.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverDevelopmentRunnerRelease as discoverRelease, resolveRunnerReleaseDescriptor as resolveRelease, createDevelopmentReleaseRuntime, verifyDevelopmentRunnerRelease } from "../src/distribution/release.js";
import { FIXED_RELEASE_VERSION, installerReleaseTarget, renderPosixInstaller, renderPowerShellInstaller } from "../src/installer.js";
import { developmentDescriptor, isDevelopmentReleaseVersion } from "../src/domain/release-selection.js";
import { runnerInstallScript, runnerRelease } from "../src/http/distribution.js";
import { boundedJson, readDevelopmentReleaseCache, releaseFetch, DevelopmentReleaseError, developmentReleaseFailure, safeDevelopmentReleaseFailure } from "../src/distribution/release-io.js";

// Each call models a new isolate, with the real runtime algorithm enabled.
function discoverDevelopmentRunnerRelease(fetchImpl: typeof fetch, verify: DevelopmentReleaseVerifier, cache?: DevelopmentReleaseCache | null, schedule?: DevelopmentReleaseRefreshScheduler) {
  return discoverRelease({ fetch: fetchImpl, verify, cache: cache ?? undefined, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() }, schedule);
}
function resolveRunnerReleaseDescriptor(environment: RunnerReleaseEnvironment, fetchImpl: typeof fetch) {
  return resolveRelease(environment, { fetch: fetchImpl, verify: verifyDevelopmentRunnerRelease, cache: undefined, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() });
}

// Development fixtures remain independent of the Worker's stable activation.
const devCore = "0.1.8";
const devVersion = (sequence: number | string): string => `${devCore}-dev.${sequence}`;

const staticAssets = ["LICENSE", "NOTICE", "SHA256SUMS", "THIRD_PARTY_NOTICES.md", "manifest.json", "manifest.sig", "manifest.signature.json", "trust-keyring.json"];
function release(version: string, publishedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1, tag_name: `v${version}`, draft: false, prerelease: true, immutable: true, published_at: publishedAt,
    assets: [...staticAssets, `runmesh-runner-${version}.tgz`].map((name) => ({ name })),
    ...overrides,
  };
}
function responseFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}
const devEnv = { RUNMESH_ENVIRONMENT: "development", WORKER_ID: "worker-development", RUNMESH_PUBLIC_ORIGIN: "https://runmeshdev.example", RUNMESH_SIGNED_RELEASE_AVAILABLE: "dev" };
afterEach(() => vi.useRealTimers());

it.each([
  [503, null, "development release discovery failed"],
  [200, String(512 * 1024 + 1), "development release discovery response is too large"],
  [200, "invalid", "development release discovery response is too large"],
] as const)("rejected release response %i with length %s cancels its body", async (status, length, message) => {
  const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ cancel });
  const response = new Response(body, { status, headers: length === null ? {} : { "content-length": length } });
  try {
    await expect(boundedJson(response)).rejects.toThrow(message);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  } finally { void body.cancel().catch(() => undefined); }
});

it.each([undefined, 100] as const)("rejected cached release cancels its body with timeout %s", async timeout => {
  const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ cancel });
  const cache: DevelopmentReleaseCache = { match: async () => new Response(body, { status: 503 }), put: async () => undefined };
  try {
    expect(await readDevelopmentReleaseCache(cache, timeout)).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  } finally { void body.cancel().catch(() => undefined); }
});

it.each(["rejected", "pending"] as const)("release rejection settles when body cancellation is %s", async mode => {
  const cancel = vi.fn(() => mode === "rejected" ? Promise.reject(new Error("synthetic cancellation failure")) : new Promise<void>(() => undefined));
  const body = new ReadableStream<Uint8Array>({ cancel });
  try {
    await expect(boundedJson(new Response(body, { status: 503 }))).rejects.toThrow("development release discovery failed");
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally { void body.cancel().catch(() => undefined); }
});

it("rejected release response cancels every retry including the final response", async () => {
  const bodies: ReadableStream<Uint8Array>[] = [], cancel = vi.fn();
  const send = vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({ cancel }); bodies.push(body);
    return new Response(body, { status: 503 });
  }) as unknown as typeof fetch;
  try {
    const response = await releaseFetch("https://example.invalid/release", { method: "GET" }, send);
    await expect(boundedJson(response)).rejects.toThrow("development release discovery failed");
    expect(send).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledTimes(3);
  } finally { for (const body of bodies) void body.cancel().catch(() => undefined); }
});

it.each([403, 429, 503])("stops rapid HTTP %s retries when the server provides Retry-After", async status => {
  const send = vi.fn(async () => new Response("limited", { status, headers: { "retry-after": "120" } })) as unknown as typeof fetch;
  const response = await releaseFetch("https://example.invalid/release", { method: "GET" }, send);
  expect(send).toHaveBeenCalledTimes(1);
  await expect(boundedJson(response)).rejects.toMatchObject({ failure: { phase: "discovery", reason: "http_error", http_status: status } });
});

it.each(["1", "0", "Wed, 07 Oct 2026 03:00:00 GMT"])("retains the release failure without sleeping or retrying an explicit window %s", async retryAfter => {
  vi.useFakeTimers();
  const send = vi.fn(async () => new Response(null, { status: 429, headers: { "retry-after": retryAfter } })) as unknown as typeof fetch;
  const pending = releaseFetch("https://example.invalid/release", { method: "GET" }, send);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await pending).status).toBe(429);
});

it("does not immediately recheck an explicitly exhausted GitHub rate limit", async () => {
  const send = vi.fn(async () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as unknown as typeof fetch;
  expect((await releaseFetch("https://example.invalid/release", { method: "GET" }, send)).status).toBe(403);
  expect(send).toHaveBeenCalledTimes(1);
});

it.each([403, 429, 503])("keeps the existing bounded retries for an ordinary HTTP %s failure", async status => {
  const send = vi.fn(async () => new Response(null, { status, headers: { "retry-after": "not-a-window", "x-ratelimit-remaining": "1" } })) as unknown as typeof fetch;
  expect((await releaseFetch("https://example.invalid/release", { method: "GET" }, send)).status).toBe(status);
  expect(send).toHaveBeenCalledTimes(3);
});

describe("release rate-limit windows", () => {
  const started = Date.UTC(2026, 9, 7, 2);
  it.each([
    [{ "retry-after": "120" }, 429, 120_000],
    [{ "retry-after": "Wed, 07 Oct 2026 02:02:00 GMT" }, 429, 120_000],
    [{ "retry-after": "999999" }, 503, 3_600_000],
    [{ "retry-after": "Wed, 07 Oct 2099 02:00:00 GMT" }, 503, 3_600_000],
    [{ "retry-after": "Thu, 07 Oct 2099 02:00:00 GMT" }, 503, undefined],
    [{ "retry-after": "NaN" }, 429, undefined],
    [{ "retry-after": "-1" }, 429, undefined],
    [{ "retry-after": "Infinity" }, 429, undefined],
    [{ "retry-after": "1.5" }, 429, undefined],
    [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((started + 180_000) / 1000) }, 403, 180_000],
    [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "NaN" }, 403, 60_000],
    [{ "x-ratelimit-remaining": "0" }, 403, 60_000],
    [{ "x-ratelimit-remaining": "1", "x-ratelimit-reset": "NaN" }, 403, undefined],
  ] as const)("bounds and validates the retry metadata %j", async (headers, status, delay) => {
    vi.useFakeTimers(); vi.setSystemTime(started);
    await expect(boundedJson(new Response(null, { status, headers }))).rejects.toMatchObject({ retry_at_ms: delay === undefined ? undefined : started + delay });
  });

  it("keeps a cold isolate from refreshing again until its retry window ends", async () => {
    vi.useFakeTimers(); vi.setSystemTime(started);
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "120" } }))
      .mockImplementation(async () => Response.json([release(devVersion(71), "2026-10-07T01:00:00Z")]));
    const runtime = createDevelopmentReleaseRuntime();
    const dependencies = { fetch: fetchImpl, verify: async () => undefined, cache: undefined, now: () => Date.now(), runtime };
    expect((await resolveRelease(devEnv, dependencies)).distributable).toBe(false);
    expect(runtime.next_refresh_at_ms).toBe(started + 120_000);
    vi.setSystemTime(started + 119_999);
    expect((await resolveRelease(devEnv, dependencies)).distributable).toBe(false); expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.setSystemTime(started + 120_000);
    expect((await resolveRelease(devEnv, dependencies)).package_version).toBe(devVersion(71)); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not extend a cached signature's hard expiry while waiting for a retry window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(started);
    const descriptor = developmentDescriptor(release(devVersion(70), "2026-10-07T01:00:00Z"))!;
    const verifiedAt = started - 3_590_000;
    const cache = { match: async () => Response.json({ schema_version: 1, verified_at_ms: verifiedAt, descriptor }), put: vi.fn(async () => undefined) };
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503, headers: { "retry-after": "120" } }));
    const runtime = createDevelopmentReleaseRuntime(), dependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => Date.now(), runtime };
    expect((await resolveRelease(devEnv, dependencies)).package_version).toBe(descriptor.package_version);
    expect(runtime.cached?.verified_at_ms).toBe(verifiedAt); expect(runtime.cached?.expires_at_ms).toBe(started + 10_000);
    vi.setSystemTime(started + 10_000);
    expect((await resolveRelease(devEnv, dependencies)).distributable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(cache.put).not.toHaveBeenCalled();
  });

  it("does not change release candidates to bypass the same asset host's retry window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(started);
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => String(url).startsWith("https://api.github.com/")
      ? Response.json([release(devVersion(72), "2026-10-07T01:00:00Z"), release(devVersion(71), "2026-10-07T01:00:00Z")])
      : new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    const runtime = createDevelopmentReleaseRuntime(), onRefreshFailure = vi.fn();
    expect((await resolveRelease(devEnv, { fetch: fetchImpl, verify: verifyDevelopmentRunnerRelease, cache: undefined, now: () => Date.now(), runtime, onRefreshFailure })).distributable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2); expect(runtime.next_refresh_at_ms).toBe(started + 120_000);
    expect(onRefreshFailure).toHaveBeenCalledWith({ phase: "manifest", reason: "http_error", http_status: 429 });
  });

  it("preserves a late asset retry window when the refresh deadline is already aborted", async () => {
    vi.useFakeTimers(); vi.setSystemTime(started);
    const controller = new AbortController(), timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).startsWith("https://api.github.com/")) return Response.json([release(devVersion(72), "2026-10-07T01:00:00Z")]);
      controller.abort(new DOMException("Refresh budget exhausted", "TimeoutError"));
      return new Response(null, { status: 429, headers: { "retry-after": "120" } });
    });
    const runtime = createDevelopmentReleaseRuntime(), onRefreshFailure = vi.fn();
    try {
      expect((await resolveRelease(devEnv, { fetch: fetchImpl, verify: verifyDevelopmentRunnerRelease, cache: undefined, now: () => Date.now(), runtime, onRefreshFailure })).distributable).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(2); expect(runtime.next_refresh_at_ms).toBe(started + 120_000);
      expect(onRefreshFailure).toHaveBeenCalledWith({ phase: "manifest", reason: "timeout" });
    } finally { timeout.mockRestore(); }
  });

  it("preserves the discovery window after independently reverifying an expired cached tag", async () => {
    vi.useFakeTimers(); vi.setSystemTime(started);
    const descriptor = developmentDescriptor(release(devVersion(70), "2026-10-07T01:00:00Z"))!;
    let stored = { schema_version: 1, verified_at_ms: started - 3_600_001, descriptor };
    const cache = { match: async () => Response.json(stored), put: vi.fn(async (_request: Request, response: Response) => { stored = await response.json() as typeof stored; }) };
    const fetchImpl = vi.fn(async () => new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    const runtime = createDevelopmentReleaseRuntime(), verify = vi.fn(async () => undefined);
    const dependencies = { fetch: fetchImpl, verify, cache, now: () => Date.now(), runtime };
    expect((await resolveRelease(devEnv, dependencies)).package_version).toBe(descriptor.package_version);
    expect(verify).toHaveBeenCalledOnce(); expect(cache.put).toHaveBeenCalledOnce();
    expect(runtime.cached?.verified_at_ms).toBe(started); expect(runtime.next_refresh_at_ms).toBe(started + 120_000);
    vi.setSystemTime(started + 61_000);
    expect((await resolveRelease(devEnv, dependencies)).package_version).toBe(descriptor.package_version);
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(runtime.cached?.verified_at_ms).toBe(started);
  });

  it("does not let a late rate-limit failure replace a newer refresh reservation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(started);
    const replies: ((response: Response) => void)[] = [];
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { replies.push(resolve); }));
    const runtime = createDevelopmentReleaseRuntime(), dependencies = { fetch: fetchImpl, verify: async () => undefined, cache: undefined, now: () => Date.now(), runtime };
    const old = resolveRelease(devEnv, dependencies); await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(started + 20_001);
    const newer = resolveRelease(devEnv, dependencies); await vi.advanceTimersByTimeAsync(0);
    const reservation = runtime.next_refresh_at_ms;
    replies[0]!(new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    expect((await old).distributable).toBe(false); expect(runtime.next_refresh_at_ms).toBe(reservation);
    replies[1]!(Response.json([release(devVersion(71), "2026-10-07T01:00:00Z")]));
    expect((await newer).package_version).toBe(devVersion(71));
  });
});

/** Observe settlement while cleanup is deliberately held, then release the fixture. */
async function beforeCancellationCompletes(action: (cancel: () => Promise<void>) => Promise<unknown>): Promise<PromiseSettledResult<unknown>> {
  vi.useFakeTimers();
  let release!: () => void, observed: PromiseSettledResult<unknown> | undefined;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const cancel = vi.fn(() => cleanup);
  const operation = action(cancel).then(
    value => { observed = { status: "fulfilled", value }; },
    reason => { observed = { status: "rejected", reason }; },
  );
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observed, "release I/O must settle before underlying cancellation finishes").toBeDefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    return observed!;
  } finally { release(); await vi.advanceTimersByTimeAsync(1_000); await operation; }
}

it("stalled cancellation does not block the next release fetch attempt", async () => {
  let attempts = 0;
  const result = await beforeCancellationCompletes(cancel => releaseFetch("https://example.invalid/release", { method: "GET" },
    (async () => ++attempts === 1 ? new Response(new ReadableStream({ cancel }), { status: 503 }) : Response.json([])) as typeof fetch));
  expect(result).toMatchObject({ status: "fulfilled", value: expect.objectContaining({ status: 200 }) });
  expect(attempts).toBe(2);
});

it.each(["oversized", "fragmented"] as const)("stalled cancellation does not delay rejection of %s discovery JSON", async mode => {
  let body!: ReadableStream<Uint8Array>;
  const result = await beforeCancellationCompletes(cancel => {
    body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(mode === "oversized" ? 512 * 1024 + 1 : 0)); }, cancel });
    return boundedJson(new Response(body));
  });
  expect(result).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: mode === "oversized"
    ? "development release discovery response is too large" : "development release discovery response is fragmented" }) });
  expect(body.locked).toBe(false);
});

it.each([
  ["status", "development release asset is unavailable"],
  ["redirect", "development release redirect is invalid"],
  ["header", "development release asset exceeds its size bound"],
  ["oversized", "development release asset exceeds its size bound"],
  ["fragmented", "development release asset is fragmented"],
] as const)("stalled cancellation does not delay rejection of a release asset: %s", async (mode, message) => {
  const descriptor = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
  let body!: ReadableStream<Uint8Array>;
  const result = await beforeCancellationCompletes(cancel => {
    body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (mode === "oversized" || mode === "fragmented") controller.enqueue(new Uint8Array(mode === "oversized" ? 64 * 1024 + 1 : 0));
    }, cancel });
    const response = new Response(body, { status: mode === "status" ? 404 : mode === "redirect" ? 302 : 200,
      headers: mode === "header" ? { "content-length": "invalid" } : {} });
    return verifyDevelopmentRunnerRelease(descriptor, (async () => response) as typeof fetch);
  });
  expect(result).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message }) });
  expect(body.locked).toBe(false);
});

it("stalled cancellation does not block a trusted release redirect", async () => {
  const descriptor = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
  const requested: string[] = [];
  const destination = "https://github.com/aloneio/runmesh/releases/download/probe/manifest.json";
  const result = await beforeCancellationCompletes(cancel => verifyDevelopmentRunnerRelease(descriptor, (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return requested.length === 1 ? new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: destination } }) : new Response(null, { status: 404 });
  }) as typeof fetch));
  expect(result).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "development release asset is unavailable" }) });
  expect(requested).toEqual([installerReleaseTarget(devVersion(0), "dev").manifest_url, destination]);
});

describe("development Runner distribution", () => {
  it("keeps the published development release available across a stable activation", async () => {
    const verify = vi.fn(async () => undefined);
    const descriptor = await discoverDevelopmentRunnerRelease(responseFetch([
      release("0.1.6-dev.35", "2026-10-04T00:49:02Z"),
    ]), verify);
    expect(descriptor).toMatchObject({ channel: "dev", distributable: true, package_version: "0.1.6-dev.35" });
    expect(descriptor.package_spec).toBe("https://github.com/aloneio/runmesh/releases/download/v0.1.6-dev.35/runmesh-runner-0.1.6-dev.35.tgz");
    expect(verify).toHaveBeenCalledExactlyOnceWith(descriptor, expect.any(Function));
  });

  it.each([
    ["0.1.6-dev.35", true],
    ["0.1.8-dev.38", true],
    ["2.0.0-dev.40", true],
    ["0.1.7", false],
    ["0.1.8-rc.38", false],
    ["0.1.8-dev.038", false],
    ["0.1.8-dev.38+local", false],
    ["9007199254740992.0.0-dev.38", false],
    ["0.1.8-dev.9007199254740992", false],
  ] as const)("validates development release version %s", (version, expected) => {
    expect(isDevelopmentReleaseVersion(version)).toBe(expected);
  });
  it("HTTP composition invokes native workerd fetch with its correct receiver", async () => {
    const dependencies = developmentReleaseDependencies({ ...env, REGISTRY: {} } as never);
    const controller = new AbortController();
    const reason = new Error("release request cancelled before network dispatch");
    controller.abort(reason);
    // Keep the actual runtime fetch: an injected mock would hide its receiver
    // requirement. An already aborted request performs no external I/O.
    await expect(dependencies.fetch("https://example.invalid/release", { signal: controller.signal })).rejects.toBe(reason);
  });

  it("selects the newest complete immutable dev prerelease and ignores unsafe candidates", async () => {
    const fetchImpl = responseFetch([
      release(devVersion(0), "2026-09-16T08:00:00Z"),
      release("0.1.0-rc.5", "2026-09-16T14:00:00Z"),
      release(devVersion(4), "2026-09-16T12:00:00Z", { immutable: false }),
      release(devVersion(3), "2026-09-16T11:00:00Z", { assets: [{ name: "manifest.json" }] }),
      release(devVersion(2), "2026-09-16T10:00:00Z", { draft: true }),
      release(devVersion(1), "2026-09-16T09:00:00Z"),
      { ...release(devVersion(9), "2026-09-16T13:00:00Z"), tag_name: `v${devCore}` },
    ]);
    const descriptor = await discoverDevelopmentRunnerRelease(fetchImpl, async () => undefined);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.github.com/repos/aloneio/runmesh/releases?per_page=20", expect.objectContaining({ redirect: "manual", cache: "no-store" }));
    expect(descriptor).toMatchObject({ channel: "dev", distributable: true, package_version: devVersion(1) });
    expect(descriptor.package_spec).toBe(`https://github.com/aloneio/runmesh/releases/download/v${devVersion(1)}/runmesh-runner-${devVersion(1)}.tgz`);
  });

  it("selects the latest development batch across stable version cores", async () => {
    const verify = vi.fn(async () => undefined);
    const descriptor = await discoverDevelopmentRunnerRelease(responseFetch([
      release("0.1.6-dev.35", "2026-10-04T10:00:00Z"),
      release("0.1.8-dev.38", "2026-10-04T09:00:00Z"),
    ]), verify);
    expect(descriptor.package_version).toBe("0.1.8-dev.38");
    expect(verify).toHaveBeenCalledExactlyOnceWith(descriptor, expect.any(Function));
  });

  it.each(["0.1.6-dev.35", "0.1.8-dev.38"])("verifies the signature and protocol of development release %s", async version => {
    const metadataFetch = responseFetch([release(version, "2026-09-16T08:00:00Z")]);
    const descriptor = await discoverDevelopmentRunnerRelease(metadataFetch, async () => undefined);
    const target = installerReleaseTarget(version, "dev");
    const manifest = { schema_version: 1, project: "runmesh", version: target.version, tag: target.tag, channel: "dev", prerelease: true, commit_sha: "a".repeat(40), protocol_min: 2, protocol_max: 2, published_at: "2026-09-16T08:00:00Z", artifacts: [{ name: target.artifact_name, platform: "node", architecture: "portable", node_major_min: 22, url: target.artifact_url, size: 123, sha256: "b".repeat(64) }] };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, manifestBytes));
    const toBase64 = (bytes: Uint8Array) => { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); };
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${toBase64(spki)}\n-----END PUBLIC KEY-----\n`;
    const signatureDescriptor = JSON.stringify({ schema_version: 1, algorithm: "ed25519", key_id: "test-dev-key", encoding: "base64", signed_file: "manifest.json" });
    const assetFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === target.manifest_url) return new Response(manifestBytes);
      if (url === target.signature_url) return new Response(toBase64(signature));
      if (url === target.signature_descriptor_url) return new Response(signatureDescriptor);
      throw new Error(`unexpected release URL: ${url}`);
    }) as unknown as typeof fetch;
    await expect(verifyDevelopmentRunnerRelease(descriptor, assetFetch, { key_id: "test-dev-key", public_key_pem: publicKeyPem })).resolves.toBeUndefined();
    const tamperedFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === target.manifest_url) return new Response(new TextEncoder().encode(JSON.stringify({ ...manifest, commit_sha: "c".repeat(40) })));
      if (url === target.signature_url) return new Response(toBase64(signature));
      if (url === target.signature_descriptor_url) return new Response(signatureDescriptor);
      throw new Error(`unexpected release URL: ${url}`);
    }) as unknown as typeof fetch;
    await expect(verifyDevelopmentRunnerRelease(descriptor, tamperedFetch, { key_id: "test-dev-key", public_key_pem: publicKeyPem })).rejects.toThrow("signature does not verify");

    const incompatibleBytes = new TextEncoder().encode(JSON.stringify({ ...manifest, protocol_min: 3, protocol_max: 3 }));
    const incompatibleSignature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, incompatibleBytes));
    const incompatibleFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === target.manifest_url) return new Response(incompatibleBytes);
      if (url === target.signature_url) return new Response(toBase64(incompatibleSignature));
      if (url === target.signature_descriptor_url) return new Response(signatureDescriptor);
      throw new Error(`unexpected release URL: ${url}`);
    }) as unknown as typeof fetch;
    await expect(verifyDevelopmentRunnerRelease(descriptor, incompatibleFetch, { key_id: "test-dev-key", public_key_pem: publicKeyPem })).rejects.toThrow("development release manifest is invalid");
  });

  it("preserves a verified cached development batch after stable activation", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([
      release("0.1.6-dev.35", "2026-10-04T00:49:02Z"),
    ]), async () => undefined);
    const cache = { match: vi.fn(async () => Response.json({ schema_version: 1, verified_at_ms: Date.now(), descriptor: seed })), put: vi.fn(async () => undefined) };
    const offline = responseFetch({}, 503), verify = vi.fn(async () => undefined);
    const descriptor = await discoverDevelopmentRunnerRelease(offline, verify, cache);
    expect(descriptor).toEqual(seed);
    expect(offline).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("retries bounded transient GitHub failures but does not weaken release validation", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("temporary", { status: 503 });
      return new Response(JSON.stringify([release(devVersion(0), "2026-09-16T08:00:00Z")]), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const descriptor = await discoverDevelopmentRunnerRelease(fetchImpl, async () => undefined);
    expect(calls).toBe(2);
    expect(descriptor).toMatchObject({ channel: "dev", distributable: true, package_version: devVersion(0) });

    let forbiddenCalls = 0;
    const forbidden = vi.fn(async () => { forbiddenCalls += 1; return new Response("forbidden", { status: 403 }); }) as unknown as typeof fetch;
    await expect(discoverDevelopmentRunnerRelease(forbidden, async () => undefined)).rejects.toThrow("development release discovery failed");
    expect(forbiddenCalls).toBe(3);
  });

  it("uses only previously verified dev descriptors as the cross-isolate outage fallback", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined, null);
    let stored: Response | undefined = new Response(JSON.stringify({ schema_version: 1, verified_at_ms: Date.now(), descriptor: seed }));
    const cache = { match: vi.fn(async () => stored?.clone()), put: vi.fn(async (_request: Request, response: Response) => { stored = response.clone(); }) };
    const offline = responseFetch({ error: "offline" }, 503);
    const fresh = await discoverDevelopmentRunnerRelease(offline, async () => undefined, cache);
    expect(fresh).toMatchObject({ channel: "dev", package_version: devVersion(0) });
    expect(offline).not.toHaveBeenCalled();

    stored = new Response(JSON.stringify({ schema_version: 1, verified_at_ms: Date.now() - 120_000, descriptor: seed }));
    const staleOffline = responseFetch({ error: "offline" }, 503);
    const stale = await discoverDevelopmentRunnerRelease(staleOffline, async () => undefined, cache);
    expect(stale).toMatchObject({ channel: "dev", package_version: devVersion(0) });
    expect(staleOffline).toHaveBeenCalledTimes(3);

    stored = new Response(JSON.stringify({ schema_version: 1, verified_at_ms: Date.now(), descriptor: { ...seed, package_spec: "https://example.invalid/tampered.tgz" } }));
    const malformedOffline = responseFetch({ error: "offline" }, 503);
    vi.useFakeTimers();
    const rejected = expect(discoverDevelopmentRunnerRelease(malformedOffline, async () => undefined, cache)).rejects.toThrow("development release discovery failed");
    await vi.advanceTimersByTimeAsync(20_500);
    await rejected;
  });

  it("persists a dev descriptor only after its verifier succeeds", async () => {
    let stored: Response | undefined;
    const cache = { match: vi.fn(async () => stored?.clone()), put: vi.fn(async (_request: Request, response: Response) => { stored = response.clone(); }) };
    const fetchImpl = responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]);
    const verifier = vi.fn(async () => undefined);
    const descriptor = await discoverDevelopmentRunnerRelease(fetchImpl, verifier, cache);
    expect(descriptor.package_version).toBe(devVersion(0));
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    const cached = await stored?.json() as { descriptor?: { package_version?: string } };
    expect(cached.descriptor?.package_version).toBe(devVersion(0));
  });

  it("returns a stale verified dev release without waiting for a slow upstream refresh", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined, null);
    let stored = new Response(JSON.stringify({ schema_version: 1, verified_at_ms: Date.now() - 120_000, descriptor: seed }));
    const cache = { match: async () => stored.clone(), put: vi.fn(async (_request: Request, value: Response) => { stored = value.clone(); }) };
    let finish!: (value: Response) => void;
    const slow = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })) as unknown as typeof fetch;
    const tasks: Promise<void>[] = [];
    const result = await discoverDevelopmentRunnerRelease(slow, async () => undefined, cache, task => { tasks.push(task); });
    expect(result.package_version).toBe(devVersion(0));
    expect(tasks).toHaveLength(1);
    expect(cache.put).not.toHaveBeenCalled();
    finish(new Response(JSON.stringify([release(devVersion(1), "2026-09-16T09:00:00Z")])));
    await Promise.all(tasks);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(await stored.json()).toMatchObject({ descriptor: { package_version: devVersion(1) } });
  });

  it("failed or unverified refreshes never extend the original cached verification time", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined, null);
    const timestamp = Date.now() - 120_000;
    const cache = { match: async () => Response.json({ schema_version: 1, verified_at_ms: timestamp, descriptor: seed }), put: vi.fn(async () => undefined) };
    const tasks: Promise<void>[] = [];
    const invalid = responseFetch([release(devVersion(1), "2026-09-16T09:00:00Z")]);
    const result = await discoverDevelopmentRunnerRelease(invalid, async () => { throw new Error("invalid signature"); }, cache, task => { tasks.push(task); });
    expect(result.package_version).toBe(seed.package_version);
    await expect(Promise.all(tasks)).resolves.toEqual([undefined]);
    expect(cache.put).not.toHaveBeenCalled();
    expect(await (await cache.match()).json()).toMatchObject({ verified_at_ms: timestamp });
  });

  it.each([3_600_000, 3_600_001, -60_000])("does not serve expired or future-dated cache records (age=%s)", async age => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined, null);
    vi.useFakeTimers();
    const cache = { match: async () => Response.json({ schema_version: 1, verified_at_ms: Date.now() - age, descriptor: seed }), put: vi.fn(async () => undefined) };
    const tasks: Promise<void>[] = [];
    const rejected = expect(discoverDevelopmentRunnerRelease(responseFetch([], 404), async () => undefined, cache, task => { tasks.push(task); })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(20_100);
    await rejected;
    expect(tasks).toHaveLength(0);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("rechecks the hard expiry after a slow persistent-cache read", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined, null);
    vi.useFakeTimers();
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const cache = {
      match: async () => { clock.mockReturnValue(started + 2_000); return Response.json({ schema_version: 1, verified_at_ms: started - 3_599_000, descriptor: seed }); },
      put: vi.fn(async () => undefined),
    };
    const schedule = vi.fn();
    try {
      const rejected = expect(discoverDevelopmentRunnerRelease(responseFetch([], 404), async () => undefined, cache, schedule)).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(20_100);
      await rejected;
      expect(schedule).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("orders development versions numerically rather than by publication timestamp", async () => {
    const result = await discoverDevelopmentRunnerRelease(responseFetch([
      release(devVersion(2), "2026-09-16T10:00:00Z"),
      release(devVersion(10), "2026-09-16T09:00:00Z"),
    ]), async () => undefined, null);
    expect(result.package_version).toBe(devVersion(10));
  });

  it("never reflects extra untrusted cache fields into a release descriptor", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined, null);
    const cache = { match: async () => Response.json({ schema_version: 1, verified_at_ms: Date.now(), descriptor: { ...seed, extra: "PRIVATE_SENTINEL", artifact: { ...seed.artifact, extra: "PRIVATE_SENTINEL" } } }), put: vi.fn(async () => undefined) };
    const result = await discoverDevelopmentRunnerRelease(responseFetch([], 404), async () => undefined, cache);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  });

  it("never publicly caches an unavailable development release or installer", async () => {
    vi.useFakeTimers();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporary", { status: 503 })));
    try {
      const runtimeEnv = { ...env, ...devEnv, REGISTRY: {} } as never;
      const pending = runnerRelease(new Request("https://runmeshdev.example/runner/releases/dev"), runtimeEnv, "dev");
      await vi.advanceTimersByTimeAsync(20_500);
      const releaseResponse = await pending;
      expect(releaseResponse.headers.get("cache-control")).toBe("no-store");
      expect(await releaseResponse.json()).toMatchObject({ channel: "dev", distributable: false });

      const installerResponse = await runnerInstallScript(new Request("https://runmeshdev.example/runner/install.sh"), new URL("https://runmeshdev.example/runner/install.sh"), runtimeEnv);
      expect(installerResponse.headers.get("cache-control")).toBe("no-store");
      expect(await installerResponse.text()).toContain("Development Runner download failed");
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("development fails closed and never falls back to the stable Runner", async () => {
    const unavailable = await resolveRunnerReleaseDescriptor(devEnv, responseFetch({ error: "unavailable" }, 503));
    expect(unavailable).toMatchObject({ channel: "dev", distributable: false, package_version: "" });
    expect(JSON.stringify(unavailable)).not.toContain(FIXED_RELEASE_VERSION);

    const fetchImpl = responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]);
    const oldStableAcknowledgement = await resolveRunnerReleaseDescriptor({ ...devEnv, RUNMESH_SIGNED_RELEASE_AVAILABLE: FIXED_RELEASE_VERSION }, fetchImpl);
    expect(oldStableAcknowledgement).toMatchObject({ channel: "dev", distributable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("production remains pinned to the reviewed stable release without network discovery", async () => {
    const fetchImpl = responseFetch([release(devVersion(9), "2026-09-16T13:00:00Z")]);
    const descriptor = await resolveRunnerReleaseDescriptor({ RUNMESH_ENVIRONMENT: "production", RUNMESH_PUBLIC_ORIGIN: "https://runmesh.example", RUNMESH_SIGNED_RELEASE_AVAILABLE: FIXED_RELEASE_VERSION }, fetchImpl);
    expect(descriptor).toMatchObject({ channel: "stable", distributable: true, package_version: FIXED_RELEASE_VERSION });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renders a dev installer pinned to the discovered immutable tag and verifies dev manifest semantics", () => {
    const target = installerReleaseTarget(devVersion(0), "dev");
    const shell = renderPosixInstaller("https://runmeshdev.example", "privileged_host", target);
    const powershell = renderPowerShellInstaller("https://runmeshdev.example", "dedicated_user", target);
    for (const script of [shell, powershell]) {
      expect(script).toContain(devVersion(0));
      expect(script).toContain(`releases/download/v${devVersion(0)}`);
      expect(script).toContain('"channel":"dev"');
      expect(script).toContain("releaseManifestProblem");
      expect(script).toContain("signature does not verify");
    }
    expect(() => installerReleaseTarget(devCore, "dev")).toThrow();
    expect(() => installerReleaseTarget(devVersion("01"), "dev")).toThrow();
  });
  it("wires waitUntil through the public dev installer HTTP route", async () => {
    const runtimeEnv = { ...env, ...devEnv, RUNMESH_TEST_MODE: "" };
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined, null);
    const cache = registryDevelopmentReleaseCache(runtimeEnv as never);
    await cache.put(new Request("https://runmesh.invalid/cache-test"), Response.json({ schema_version: 1, verified_at_ms: Date.now() - 120_000, descriptor: seed }));
    let finish!: (value: Response) => void;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const ctx = createExecutionContext();
    const background = vi.spyOn(ctx, "waitUntil");
    try {
      const response = await worker.fetch(new Request("https://runmeshdev.example/runner/install.sh?channel=stable", { headers: { host: "runmeshdev.example" } }), runtimeEnv as never, ctx);
      const body = await response.text();
      expect(body).toContain(`VERSION='${devVersion(0)}'`);
      expect(body).not.toContain(`releases/download/v${FIXED_RELEASE_VERSION}/`);
      expect(background).toHaveBeenCalled();
      finish(new Response("not found", { status: 404 }));
      await waitOnExecutionContext(ctx);
    } finally { if (finish !== undefined) finish(new Response("not found", { status: 404 })); await waitOnExecutionContext(ctx); vi.stubGlobal("fetch", originalFetch); }
  });

});


describe("explicit development release runtime", () => {

  it.each(["read headers", "read body", "write headers"])("bounds Registry cache %s without blocking release discovery", async phase => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void, finishBody!: () => void;
    const cancel = vi.fn(), response = new Response(new ReadableStream({ start(controller) { finishBody = () => controller.close(); }, cancel }));
    const registryFetch = vi.fn((_request: Request) => phase === "read body" ? Promise.resolve(response) : new Promise<Response>(resolve => { finish = resolve; }));
    const cache = registryDevelopmentReleaseCache({ ...env, REGISTRY: { idFromName: () => "registry", get: () => ({ fetch: registryFetch }) } } as never);
    let settled = false;
    const request = new Request("https://cache.test/verified");
    const pending = (phase === "write headers" ? cache.put(request, Response.json({ schema_version: 1 })) : readDevelopmentReleaseCache(cache))
      .then(value => { settled = true; return value; }, () => { settled = true; return undefined; });
    await vi.waitFor(() => expect(registryFetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5_000);
    const bounded = settled;
    // Cleanup remains deterministic even before the production deadline exists.
    if (!bounded && phase !== "write headers") finishBody();
    if (phase !== "read body") finish(response);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(bounded).toBe(true);
    expect(registryFetch.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])("cancels Registry recovery %s when its caller budget ends", async phase => {
    vi.useFakeTimers();
    let failRefresh!: (response: Response) => void;
    let finish!: (response: Response) => void;
    const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }));
    const registryFetch = vi.fn((_request: Request): Promise<Response> => phase === "body"
      ? Promise.resolve(response) : new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const cache = registryDevelopmentReleaseCache({ ...env, REGISTRY: { idFromName: () => "registry", get: () => ({ fetch: registryFetch }) } } as never);
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { failRefresh = resolve; }));
    const pending = resolveRelease(devEnv, { fetch: fetchImpl, verify: async () => undefined, cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() });
    await vi.advanceTimersByTimeAsync(19_000);
    failRefresh(new Response(null, { status: 404 }));
    await vi.waitFor(() => expect(registryFetch).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    const abortedAtDeadline = registryFetch.mock.calls[1]?.[0].signal.aborted;
    const timersAtDeadline = vi.getTimerCount(), cancelledAtDeadline = cancel.mock.calls.length;
    // Settle ignored aborts before asserting, including on the unfixed path.
    if (phase === "headers") finish(response);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toMatchObject({ distributable: false });
    expect(abortedAtDeadline).toBe(true);
    expect(timersAtDeadline).toBe(0);
    if (phase === "body") expect(cancelledAtDeadline).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(registryFetch).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["GET", "POST"])("returns a verified release when Registry cache %s stalls", async method => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const registryFetch = vi.fn((request: Request) => request.method === method
      ? new Promise<Response>(resolve => { finish = resolve; })
      : Promise.resolve(new Response(null, { status: request.method === "GET" ? 404 : 204 })));
    const runtimeEnv = { ...env, REGISTRY: { idFromName: () => "registry", get: () => ({ fetch: registryFetch }) } };
    const fetchImpl = responseFetch([release(devVersion(1), "2026-09-16T09:00:00Z")]), verify = vi.fn(async () => undefined);
    const dependencies = { ...developmentReleaseDependencies(runtimeEnv as never), fetch: fetchImpl, verify };
    let settled = false;
    const pending = resolveRelease(devEnv, dependencies).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(registryFetch.mock.calls.some(([request]) => request.method === method)).toBe(true));
    await vi.advanceTimersByTimeAsync(5_000);
    try { await vi.waitFor(() => expect(settled).toBe(true)); }
    finally { finish(new Response(null, { status: method === "GET" ? 404 : 204 })); await vi.advanceTimersByTimeAsync(0); }
    expect(await pending).toMatchObject({ channel: "dev", distributable: true, package_version: devVersion(1) });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(registryFetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes cold waiters after the recovery deadline when storage remains unavailable", async () => {
    vi.useFakeTimers();
    let finishRefresh!: (response: Response) => void;
    const cache = { match: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockImplementation(() => new Promise<Response | undefined>(() => {})), put: vi.fn(async () => undefined) };
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finishRefresh = resolve; }));
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() };
    let settled = 0;
    const owner = resolveRelease(devEnv, dependencies).then(value => { settled++; return value; });
    await vi.advanceTimersByTimeAsync(0);
    const waiter = resolveRelease(devEnv, dependencies).then(value => { settled++; return value; });
    await vi.advanceTimersByTimeAsync(0);
    finishRefresh(new Response(null, { status: 404 }));
    await vi.advanceTimersByTimeAsync(19_000);
    expect(settled).toBe(0);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await Promise.all([owner, waiter])).toEqual([expect.objectContaining({ distributable: false }), expect.objectContaining({ distributable: false })]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cache.match.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(cache.match.mock.calls.length).toBeLessThanOrEqual(30);
    expect(cache.put).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["missing", "stalled after miss"])("bounds the whole recovery budget when storage is %s", async phase => {
    vi.useFakeTimers();
    const cache = { match: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockImplementation(() => phase === "missing" ? Promise.resolve(undefined) : new Promise<Response | undefined>(() => {})), put: vi.fn(async () => undefined) };
    const fetchImpl = responseFetch([], 404);
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() };
    let settled = false;
    const pending = resolveRelease(devEnv, dependencies).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await pending).toMatchObject({ distributable: false });
    expect(cache.match.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(cache.match.mock.calls.length).toBeLessThanOrEqual(25);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cache.put).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1_500, 3_000, 10_000])("keeps cold recovery available while another instance verifies for %s ms", async delayMs => {
    vi.useFakeTimers();
    let stored: string | undefined, finishVerification!: () => void;
    const cache = { match: vi.fn(async () => stored === undefined ? undefined : new Response(stored)),
      put: vi.fn(async (_request: Request, response: Response) => { stored = await response.text(); }) };
    const verify = vi.fn(() => new Promise<void>(resolve => { finishVerification = resolve; }));
    const successful: DevelopmentReleaseDependencies = { fetch: responseFetch([release(devVersion(1), "2026-09-16T09:00:00Z")]),
      verify, cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() };
    const winner = resolveRelease(devEnv, successful);
    await vi.advanceTimersByTimeAsync(0);
    expect(verify).toHaveBeenCalledOnce();
    const failedFetch = responseFetch([], 404);
    let settled = 0;
    const waiting = Promise.all(Array.from({ length: 3 }, () => resolveRelease(devEnv, { ...successful, fetch: failedFetch,
      runtime: createDevelopmentReleaseRuntime() }).then(value => { settled++; return value; })));
    await vi.advanceTimersByTimeAsync(delayMs);
    const prematurelySettled = settled;
    finishVerification();
    const verified = await winner;
    await vi.advanceTimersByTimeAsync(1_000);
    const recovered = await waiting;
    expect(prematurelySettled).toBe(0);
    expect(recovered).toEqual(Array(3).fill(verified));
    expect(failedFetch).toHaveBeenCalledTimes(3);
    expect(verify).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 2, 3])("recovers cold instances when another verification finishes after their first recovery miss (round %s)", async () => {
    let stored: string | undefined, finishVerification!: () => void;
    const cache = { match: vi.fn(async () => stored === undefined ? undefined : new Response(stored)),
      put: vi.fn(async (_request: Request, response: Response) => { stored = await response.text(); }) };
    const verify = vi.fn(() => new Promise<void>(resolve => { finishVerification = resolve; }));
    const successful: DevelopmentReleaseDependencies = { fetch: responseFetch([release(devVersion(1), "2026-09-16T09:00:00Z")]),
      verify, cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() };
    const winner = resolveRelease(devEnv, successful);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    const misses = vi.fn(async () => cache.match()), failedFetch = responseFetch([], 404);
    let settled = 0;
    const waiting = Promise.all(Array.from({ length: 3 }, () => resolveRelease(devEnv, { ...successful, fetch: failedFetch,
      cache: { ...cache, match: misses }, runtime: createDevelopmentReleaseRuntime() }).then(value => { settled++; return value; })));
    await vi.waitFor(() => expect(misses.mock.calls.length).toBeGreaterThanOrEqual(6));
    const prematurelySettled = settled;
    finishVerification();
    const verified = await winner;
    expect(await waiting).toEqual(Array(3).fill(verified));
    expect(prematurelySettled).toBe(0);
    expect(failedFetch).toHaveBeenCalledTimes(3);
    expect(verify).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 3])("recovers a release verified by another runtime before refresh failure (round %s)", async () => {
    const now = Date.now(); let stored: string | undefined, finishFailure!: () => void;
    const failure = new Promise<void>(resolve => { finishFailure = resolve; });
    const cache = { match: vi.fn(async () => stored === undefined ? undefined : new Response(stored)),
      put: vi.fn(async (_request: Request, response: Response) => { stored = await response.text(); }) };
    const fetchImpl = vi.fn(async () => { await failure; return new Response("unavailable", { status: 503 }); });
    const failing: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: vi.fn(async () => undefined), cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const successful: DevelopmentReleaseDependencies = { ...failing, fetch: responseFetch([release(devVersion(1), "2026-09-16T09:00:00Z")]), verify: vi.fn(async () => undefined), runtime: createDevelopmentReleaseRuntime() };
    const pending = resolveRelease(devEnv, failing);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const verified = await resolveRelease(devEnv, successful);
    expect(verified.distributable).toBe(true);
    finishFailure();
    expect(await pending).toEqual(verified);
    expect(await resolveRelease(devEnv, failing)).toEqual(verified);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(failing.verify).not.toHaveBeenCalled();
    expect(successful.verify).toHaveBeenCalledOnce();
    expect(cache.match).toHaveBeenCalledTimes(3);
    expect(cache.put).toHaveBeenCalledOnce();
    expect(failing.runtime.cached?.verified_at_ms).toBe(now);
    expect(Object.values(failing.runtime).some(value => value instanceof Promise)).toBe(false);
  });

  it.each(["foreground", "background"])("recovers the newest verified cache over stale memory after a %s refresh fails", async mode => {
    let now = Date.now(), stored: string | undefined, finishFailure!: (response: Response) => void;
    const cache = { match: vi.fn(async () => stored === undefined ? undefined : new Response(stored)),
      put: vi.fn(async (_request: Request, response: Response) => { stored = await response.text(); }) };
    const dependencies: DevelopmentReleaseDependencies = { fetch: responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]),
      verify: vi.fn(async () => undefined), cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const seed = await resolveRelease(devEnv, dependencies);
    now += 60_001;
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finishFailure = resolve; }));
    const failing = { ...dependencies, fetch: fetchImpl }, tasks: Promise<void>[] = [];
    const pending = resolveRelease(devEnv, failing, mode === "background" ? task => { tasks.push(task); } : undefined);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    now += 1;
    const newest = await resolveRelease(devEnv, { ...dependencies, runtime: createDevelopmentReleaseRuntime(),
      fetch: responseFetch([release(devVersion(1), "2026-09-16T09:00:00Z")]) });
    finishFailure(new Response("unavailable", { status: 404 }));
    const immediate = await pending;
    await Promise.all(tasks);
    expect(immediate).toEqual(mode === "background" ? seed : newest);
    expect(await resolveRelease(devEnv, failing)).toEqual(newest);
    expect(dependencies.runtime.cached?.verified_at_ms).toBe(now);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cache.put).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2, 3])("keeps cold waiters pending until cross-isolate recovery completes (round %s)", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(1), "2026-09-16T09:00:00Z")]), async () => undefined);
    vi.useFakeTimers();
    const verifiedAtMs = Date.now();
    let finishRefresh!: (response: Response) => void, finishRead!: (response: Response) => void;
    const cache = { match: vi.fn(async (): Promise<Response | undefined> => undefined), put: vi.fn(async () => undefined) };
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finishRefresh = resolve; }));
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() };
    const owner = resolveRelease(devEnv, dependencies);
    await vi.advanceTimersByTimeAsync(0);
    let settled = 0;
    const waiters = Promise.all(Array.from({ length: 3 }, () => resolveRelease(devEnv, dependencies).then(value => { settled++; return value; })));
    await vi.advanceTimersByTimeAsync(0);
    cache.match.mockImplementationOnce(() => new Promise<Response>(resolve => { finishRead = resolve; }));
    finishRefresh(new Response("unavailable", { status: 404 }));
    await vi.advanceTimersByTimeAsync(100);
    const prematurelySettled = settled;
    finishRead(Response.json({ schema_version: 1, verified_at_ms: verifiedAtMs, descriptor: seed }));
    const recovered = await owner;
    await vi.advanceTimersByTimeAsync(100);
    const concurrent = await waiters;
    expect(prematurelySettled).toBe(0);
    expect(recovered).toEqual(seed);
    expect(concurrent).toEqual(Array(3).fill(seed));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cache.match).toHaveBeenCalledTimes(5);
    expect(cache.put).not.toHaveBeenCalled();
    expect(dependencies.runtime.cached?.verified_at_ms).toBe(verifiedAtMs);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["expired", "future", "invalid"])("rejects a newly observed %s record after refresh failure", async kind => {
    const now = Date.now();
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
    vi.useFakeTimers();
    const record = { schema_version: 1, verified_at_ms: kind === "future" ? now + 1 : kind === "expired" ? now - 3_600_000 : now - 1_000,
      descriptor: kind === "invalid" ? { ...seed, signature_url: "https://untrusted.invalid/manifest.sig" } : seed };
    const cache = { match: vi.fn().mockResolvedValueOnce(undefined).mockImplementation(async () => Response.json(record)), put: vi.fn(async () => undefined) };
    const dependencies: DevelopmentReleaseDependencies = { fetch: responseFetch([], 404), verify: vi.fn(async () => undefined), cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const pending = resolveRelease(devEnv, dependencies);
    await vi.advanceTimersByTimeAsync(20_100);
    expect(await pending).toMatchObject({ distributable: false });
    expect(cache.match.mock.calls.length).toBeGreaterThan(1);
    expect(cache.match.mock.calls.length).toBeLessThanOrEqual(25);
    expect(cache.put).not.toHaveBeenCalled();
    expect(dependencies.runtime.cached).toBeUndefined();
  });

  it.each(["headers", "body"])("bounds the failed-refresh recovery %s and discards late storage results", async phase => {
    vi.useFakeTimers();
    let finishRead!: (response: Response) => void;
    const cancel = vi.fn(), response = new Response(new ReadableStream({ cancel }));
    const cache = { match: vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => phase === "body" ? Promise.resolve(response) : new Promise<Response>(resolve => { finishRead = resolve; })), put: vi.fn(async () => undefined) };
    const dependencies: DevelopmentReleaseDependencies = { fetch: responseFetch([], 404), verify: async () => undefined, cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() };
    let settled = false;
    const pending = resolveRelease(devEnv, dependencies).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(19_000); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100); expect(await pending).toMatchObject({ distributable: false });
    if (phase === "headers") { finishRead(response); await vi.advanceTimersByTimeAsync(0); }
    expect(cancel).toHaveBeenCalledOnce();
    expect(dependencies.runtime.cached).toBeUndefined();
    expect(cache.put).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks the original hard expiry after recovery storage latency", async () => {
    vi.useFakeTimers();
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
    const verifiedAtMs = Date.now() - 3_600_000 + 500;
    const cache = { match: vi.fn().mockResolvedValueOnce(Response.json({ schema_version: 1, verified_at_ms: verifiedAtMs, descriptor: seed }))
      .mockImplementationOnce(() => new Promise<Response | undefined>(() => {})), put: vi.fn(async () => undefined) };
    const dependencies: DevelopmentReleaseDependencies = { fetch: responseFetch([], 404), verify: async () => undefined, cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() };
    const pending = resolveRelease(devEnv, dependencies);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ distributable: false });
    expect(dependencies.runtime.cached).toBeUndefined();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("keeps a concurrent verified value when a recovery read completes late", async () => {
    let now = Date.now(), finishRead!: (response: Response) => void;
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
    const cache = { match: vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<Response>(resolve => { finishRead = resolve; })).mockResolvedValue(undefined), put: vi.fn(async () => undefined) };
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("missing", { status: 404 })).mockImplementation(async () => Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")]));
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const older = resolveRelease(devEnv, dependencies);
    await vi.waitFor(() => expect(cache.match).toHaveBeenCalledTimes(2));
    now += 20_001; // A pending recovery still owns the original refresh lease.
    const newer = await resolveRelease(devEnv, dependencies);
    finishRead(Response.json({ schema_version: 1, verified_at_ms: now - 1_000, descriptor: seed }));
    expect(await older).toEqual(newer);
    expect(dependencies.runtime.cached?.verified_at_ms).toBe(now);
    expect(cache.put).toHaveBeenCalledOnce();
  });

  it.each([1_000, 120_000])("keeps a verified persistent release available during another request's first cache read (age %s ms)", async ageMs => {
    const now = Date.now();
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
    const record = { schema_version: 1, verified_at_ms: now - ageMs, descriptor: seed };
    let finishRead!: (response: Response) => void;
    const cache = { match: vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishRead = resolve; }))
      .mockImplementation(async () => Response.json(record)), put: vi.fn(async () => undefined) };
    const fetchImpl = responseFetch([], 404);
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const first = resolveRelease(devEnv, dependencies);
    try {
      const concurrent = await resolveRelease(devEnv, dependencies);
      expect(concurrent).toEqual(seed);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
      expect(Object.values(dependencies.runtime).some(value => value instanceof Promise)).toBe(false);
    } finally {
      finishRead(Response.json(record));
      await first;
    }
  });

  it.each(["expired", "future", "invalid"])("rejects %s persistent records during another request's cache read", async kind => {
    const now = Date.now();
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
    const record = { schema_version: 1, verified_at_ms: kind === "future" ? now + 1 : kind === "expired" ? now - 3_600_000 : now - 1_000,
      descriptor: kind === "invalid" ? { ...seed, signature_url: "https://untrusted.invalid/manifest.sig" } : seed };
    vi.useFakeTimers();
    let finishRead!: (response: Response | undefined) => void;
    const cache = { match: vi.fn().mockImplementationOnce(() => new Promise<Response | undefined>(resolve => { finishRead = resolve; }))
      .mockImplementation(async () => Response.json(record)), put: vi.fn(async () => undefined) };
    const fetchImpl = responseFetch([], 404);
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const first = resolveRelease(devEnv, dependencies);
    try {
      const concurrent = resolveRelease(devEnv, dependencies);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await concurrent).toMatchObject({ channel: "dev", distributable: false, package_version: "" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
    } finally { finishRead(undefined); await vi.advanceTimersByTimeAsync(20_100); await first; }
  });

  it("prefers a completed refresh over a concurrent late storage snapshot", async () => {
    const now = Date.now();
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
    let finishRead!: (response: Response) => void;
    let finishRefresh!: (response: Response) => void;
    const cache = { match: vi.fn().mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishRead = resolve; })), put: vi.fn(async () => undefined) };
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finishRefresh = resolve; })) as typeof fetch;
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const first = resolveRelease(devEnv, dependencies);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const concurrent = resolveRelease(devEnv, dependencies);
    expect(cache.match).toHaveBeenCalledTimes(2);
    finishRefresh(Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")]));
    const latest = await first;
    finishRead(Response.json({ schema_version: 1, verified_at_ms: now - 1_000, descriptor: seed }));
    expect((await concurrent).package_version).toBe(devVersion(1));
    expect(await resolveRelease(devEnv, dependencies)).toEqual(latest);
    expect(cache.put).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rechecks persistent hard expiry after a concurrent storage read completes", async () => {
    let now = Date.now();
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
    const record = { schema_version: 1, verified_at_ms: now - 3_599_999, descriptor: seed };
    vi.useFakeTimers();
    const reads: ((response: Response | undefined) => void)[] = [];
    const cache = { match: vi.fn(() => new Promise<Response | undefined>(resolve => { reads.push(resolve); })), put: vi.fn(async () => undefined) };
    const fetchImpl = responseFetch([], 404);
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const first = resolveRelease(devEnv, dependencies);
    const concurrent = resolveRelease(devEnv, dependencies);
    expect(reads).toHaveLength(2);
    now += 2;
    reads[1]!(Response.json(record));
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await concurrent).toMatchObject({ channel: "dev", distributable: false, package_version: "" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
    } finally {
      reads[0]!(undefined);
      await vi.advanceTimersByTimeAsync(0);
      reads[2]?.(undefined);
      await vi.advanceTimersByTimeAsync(20_100);
      await first;
    }
  });

  it("serves concurrent cold requests after one discovery and successful verification", async () => {
    let finish!: (response: Response) => void;
    let finishVerification!: () => void;
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) };
    const verify = vi.fn(() => new Promise<void>(resolve => { finishVerification = resolve; }));
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify, cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() };
    const first = discoverRelease(dependencies);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    let settled = 0;
    const concurrent = Promise.all(Array.from({ length: 20 }, () => discoverRelease(dependencies).then(result => { settled++; return result; })));
    expect(cache.match).toHaveBeenCalledTimes(21);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.values(dependencies.runtime).some(value => value instanceof Promise)).toBe(false);
    finish(Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")]));
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    expect(settled).toBe(0);
    expect(dependencies.runtime.cached).toBeUndefined();
    finishVerification();
    const descriptor = await first;
    expect(await concurrent).toEqual(Array(20).fill(descriptor));
    expect(await Promise.all(Array.from({ length: 20 }, () => discoverRelease(dependencies)))).toEqual(Array(20).fill(descriptor));
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("finishes waiting callers promptly when signature verification fails", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    let rejectVerification!: (error: Error) => void;
    const verify = vi.fn(() => new Promise<void>((_, reject) => { rejectVerification = reject; }));
    const fetchImpl = responseFetch([release(devVersion(1), "2026-09-16T09:00:00Z")]);
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify, cache: undefined, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const first = resolveRelease(devEnv, dependencies);
    await vi.advanceTimersByTimeAsync(0);
    const concurrent = Promise.all(Array.from({ length: 20 }, () => resolveRelease(devEnv, dependencies)));
    await vi.advanceTimersByTimeAsync(0);
    rejectVerification(new Error("invalid signature"));
    expect((await first).distributable).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect((await concurrent).every(result => !result.distributable)).toBe(true);
    expect((await resolveRelease(devEnv, dependencies)).distributable).toBe(false);
    expect(dependencies.runtime.cached).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
  });

  it("bounds repeated failed cold refreshes and recovers after a short in-memory cooldown", async () => {
    vi.useFakeTimers();
    let now = Date.now();
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json([]))
      .mockImplementation(async () => Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")])) as typeof fetch;
    const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) };
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    for (let round = 0; round < 2; round++) {
      const pending = Promise.allSettled(Array.from({ length: 20 }, () => discoverRelease(dependencies)));
      await vi.advanceTimersByTimeAsync(20_100);
      const results = await pending;
      expect(results.every(result => result.status === "rejected")).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(cache.match.mock.calls.length).toBeGreaterThan(20 * (round + 1));
      expect(cache.match.mock.calls.length).toBeLessThanOrEqual(20 * (round + 1) + 25);
      expect(cache.put).not.toHaveBeenCalled();
    }
    now += 5_001;
    expect((await discoverRelease(dependencies)).package_version).toBe(devVersion(1));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("renews an owned reservation after slow cache I/O for the complete network refresh budget", async () => {
    vi.useFakeTimers();
    let now = Date.now();
    let finishRead!: (response: Response | undefined) => void;
    let finishRefresh!: (response: Response) => void;
    const cache = { match: vi.fn().mockImplementationOnce(() => new Promise<Response | undefined>(resolve => { finishRead = resolve; })).mockResolvedValue(undefined), put: vi.fn(async () => undefined) };
    const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishRefresh = resolve; }))
      .mockImplementation(async () => Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")])) as typeof fetch;
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const first = discoverRelease(dependencies);
    expect(cache.match).toHaveBeenCalledOnce();
    now += 20_001;
    finishRead(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    try {
      let settled = 0;
      const concurrent = Promise.all(Array.from({ length: 20 }, () => discoverRelease(dependencies).then(result => { settled++; return result; })));
      now += 19_999;
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(0);
      expect(cache.match).toHaveBeenCalledTimes(21);
      expect(fetchImpl).toHaveBeenCalledOnce();
      finishRefresh(Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")]));
      const descriptor = await first;
      await vi.advanceTimersByTimeAsync(100);
      expect(descriptor.package_version).toBe(devVersion(1));
      expect(await concurrent).toEqual(Array(20).fill(descriptor));
      expect(cache.put).toHaveBeenCalledOnce();
    } finally {
      finishRefresh(Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")]));
      await first.catch(() => undefined);
    }
  });

  it("bounds a cold caller's own waiting even when its clock stops advancing", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache: undefined, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const first = resolveRelease(devEnv, dependencies);
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    const concurrent = resolveRelease(devEnv, dependencies).then(result => { settled = true; return result; });
    try {
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await concurrent).toMatchObject({ distributable: false });
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      finish(Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")]));
      expect((await first).package_version).toBe(devVersion(1));
    }
  });

  it("does not extend a cold caller's deadline when an abandoned refresh lease is replaced", async () => {
    vi.useFakeTimers();
    let now = Date.now();
    const finishes: ((response: Response) => void)[] = [];
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finishes.push(resolve); })) as typeof fetch;
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache: undefined, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const first = resolveRelease(devEnv, dependencies);
    await vi.advanceTimersByTimeAsync(0);
    now += 10_000;
    let settled = false;
    const concurrent = resolveRelease(devEnv, dependencies).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    now += 10_001;
    const replacement = resolveRelease(devEnv, dependencies);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    now += 9_999;
    await vi.advanceTimersByTimeAsync(100);
    expect(await concurrent).toMatchObject({ distributable: false });
    finishes[1]!(Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")]));
    expect((await replacement).package_version).toBe(devVersion(1));
    finishes[0]!(Response.json([release(devVersion(0), "2026-09-16T08:00:00Z")]));
    expect((await first).package_version).toBe(devVersion(1));
  });

  it("rechecks verified memory hard expiry before waking cold callers", async () => {
    vi.useFakeTimers();
    let now = Date.now();
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache: undefined, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const first = resolveRelease(devEnv, dependencies);
    await vi.advanceTimersByTimeAsync(0);
    const concurrent = resolveRelease(devEnv, dependencies);
    await vi.advanceTimersByTimeAsync(0);
    finish(Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")]));
    expect((await first).distributable).toBe(true);
    now += 3_600_000;
    await vi.advanceTimersByTimeAsync(100);
    expect(await concurrent).toMatchObject({ distributable: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("isolates discovery values and cooldowns by Registry binding", async () => {
    vi.useFakeTimers();
    const firstBinding = {}, secondBinding = {};
    const first = developmentReleaseDependencies({ ...env, REGISTRY: firstBinding } as never);
    expect(developmentReleaseDependencies({ ...env, REGISTRY: firstBinding } as never).runtime).toBe(first.runtime);
    const second = developmentReleaseDependencies({ ...env, REGISTRY: secondBinding } as never);
    expect(second.runtime).not.toBe(first.runtime);
    const rejected = expect(discoverRelease({ ...first, fetch: responseFetch([], 404), verify: async () => undefined })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(20_100);
    await rejected;
    expect((await discoverRelease({ ...second, fetch: responseFetch([release(devVersion(1), "2026-09-16T09:00:00Z")]), verify: async () => undefined })).package_version).toBe(devVersion(1));
    expect(first.runtime.cached).toBeUndefined();
  });

  it("uses the same runtime cache with injected fetch and verifier", async () => {
    let now = Date.now();
    const fetchImpl = responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]);
    const verify = vi.fn(async () => undefined);
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify, cache: undefined, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const first = await discoverRelease(dependencies);
    now += 1000;
    expect(await discoverRelease(dependencies)).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    now += 60_000;
    await discoverRelease(dependencies);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("does not let a late persistent read overwrite a newer runtime refresh", async () => {
    let now = Date.now();
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
    let finishRead!: (response: Response | undefined) => void;
    const cache = { match: vi.fn().mockImplementationOnce(() => new Promise<Response | undefined>(resolve => { finishRead = resolve; })).mockResolvedValue(undefined), put: vi.fn(async () => undefined) };
    const dependencies: DevelopmentReleaseDependencies = { fetch: responseFetch([release(devVersion(1), "2026-09-16T09:00:00Z")]), verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const older = discoverRelease(dependencies);
    now += 20_001; // Recover an abandoned request's expired reservation.
    const newer = await discoverRelease(dependencies);
    finishRead(Response.json({ schema_version: 1, verified_at_ms: now - 1000, descriptor: seed }));
    expect((await older).package_version).toBe(newer.package_version);
    expect(dependencies.runtime.cached?.descriptor.package_version).toBe(devVersion(1));
  });

  it("does not let an older refresh finishing last roll back a newer committed refresh", async () => {
    let now = Date.now();
    let finishOlder!: (response: Response) => void;
    const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishOlder = resolve; })).mockImplementation(async () => Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")])) as typeof fetch;
    const cache = { match: async () => undefined, put: vi.fn(async () => undefined) };
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const older = discoverRelease(dependencies);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    now += 20_001; // An ignored abort cannot hold the value-only lease forever.
    const newer = discoverRelease(dependencies);
    expect((await newer).package_version).toBe(devVersion(1));
    finishOlder(Response.json([release(devVersion(0), "2026-09-16T08:00:00Z")]));
    expect((await older).package_version).toBe(devVersion(1));
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(dependencies.runtime.cached?.descriptor.package_version).toBe(devVersion(1));
  });

  it("throttles stale refresh launches without sharing I/O promises or extending hard expiry", async () => {
    let now = Date.now();
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
    const verifiedAtMs = now - 120_000;
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockImplementation(async () => new Response("missing", { status: 404 })) as typeof fetch;
    const cache = { match: async () => Response.json({ schema_version: 1, verified_at_ms: verifiedAtMs, descriptor: seed }), put: vi.fn(async () => undefined) };
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    const tasks: Promise<void>[] = [];
    const schedule = (work: Promise<void>) => { tasks.push(work); };
    expect((await discoverRelease(dependencies, schedule)).package_version).toBe(seed.package_version);
    expect((await discoverRelease(dependencies, schedule)).package_version).toBe(seed.package_version);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveLength(1);
    expect(Object.values(dependencies.runtime).some(value => value instanceof Promise)).toBe(false);
    finish(new Response("missing", { status: 404 }));
    await Promise.all(tasks);
    expect(dependencies.runtime.cached?.verified_at_ms).toBe(verifiedAtMs);
    expect(cache.put).not.toHaveBeenCalled();
    now = verifiedAtMs + 3_600_000;
    await expect(discoverRelease(dependencies, schedule)).rejects.toThrow();
  });

  it("rejects future-dated memory and keeps verified releases available through cache-write failures", async () => {
    const now = Date.now();
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
    const runtime = createDevelopmentReleaseRuntime();
    runtime.cached = { descriptor: seed, verified_at_ms: now + 1, expires_at_ms: now + 60_000 };
    await expect(discoverRelease({ fetch: responseFetch([], 404), verify: async () => undefined, cache: undefined, now: () => now, runtime })).rejects.toThrow();
    const cache = { match: async () => undefined, put: vi.fn(async () => { throw new Error("cache unavailable"); }) };
    const result = await discoverRelease({ fetch: responseFetch([release(devVersion(1), "2026-09-16T09:00:00Z")]), verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() });
    expect(result.package_version).toBe(devVersion(1));
    expect(cache.put).toHaveBeenCalledTimes(1);
  });
});


it("a failed older refresh cannot replace a concurrent verified runtime value with its stale snapshot", async () => {
  let now = Date.now();
  const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
  let finishOld!: (value: Response) => void;
  const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve; }))
    .mockImplementation(async () => Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")])) as typeof fetch;
  const verifiedAtMs = now - 120_000;
  const cache = { match: async () => Response.json({ schema_version: 1, verified_at_ms: verifiedAtMs, descriptor: seed }), put: vi.fn(async () => undefined) };
  const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
  const older = discoverRelease(dependencies);
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  now += 20_001;
  const newer = discoverRelease(dependencies);
  expect((await newer).package_version).toBe(devVersion(1));
  const newerVerification = dependencies.runtime.cached?.verified_at_ms;
  now += 1_000;
  finishOld(new Response("missing", { status: 404 }));
  expect((await older).package_version).toBe(devVersion(1));
  expect(dependencies.runtime.cached?.verified_at_ms).toBe(newerVerification);
  expect(cache.put).toHaveBeenCalledTimes(1);
});

it("reports one refresh failure after retries without duplicate waiter or cooldown events", async () => {
  vi.useFakeTimers();
  const onRefreshFailure = vi.fn(), fetchImpl = responseFetch({ private_token: "PRIVATE_SENTINEL" }, 503);
  const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache: undefined,
    now: () => Date.now(), runtime: createDevelopmentReleaseRuntime(), onRefreshFailure };
  const pending = Promise.all(Array.from({ length: 4 }, () => resolveRelease(devEnv, dependencies)));
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await pending).every(value => !value.distributable)).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(onRefreshFailure.mock.calls).toEqual([[{ phase: "discovery", reason: "http_error", http_status: 503 }]]);
  expect(await resolveRelease(devEnv, dependencies)).toMatchObject({ distributable: false });
  expect(onRefreshFailure).toHaveBeenCalledOnce();
});

it.each(["manifest", "signature", "signature_descriptor"] as const)("reports the actual %s download failure without asset URLs or response values", async phase => {
  const version = devVersion(0), target = installerReleaseTarget(version, "dev"), onRefreshFailure = vi.fn();
  const failedUrl = phase === "manifest" ? target.manifest_url : phase === "signature" ? target.signature_url : target.signature_descriptor_url;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes("api.github.com")
    ? Response.json([release(version, "2026-09-16T08:00:00Z")])
    : new Response("PRIVATE_SENTINEL", { status: String(input) === failedUrl ? 404 : 200 }));
  const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: verifyDevelopmentRunnerRelease, cache: undefined,
    now: () => Date.now(), runtime: createDevelopmentReleaseRuntime(), onRefreshFailure };
  expect(await resolveRelease(devEnv, dependencies)).toMatchObject({ distributable: false });
  expect(onRefreshFailure.mock.calls).toEqual([[{ phase, reason: "http_error", http_status: 404 }]]);
  expect(JSON.stringify(onRefreshFailure.mock.calls)).not.toMatch(/PRIVATE_SENTINEL|github|https/u);
});

it("reports a failed background refresh once after recovery while preserving its cached result even when observation throws", async () => {
  const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined);
  const now = Date.now(), stored = { schema_version: 1, verified_at_ms: now - 120_000, descriptor: seed };
  const cache = { match: vi.fn(async () => Response.json(stored)), put: vi.fn(async () => undefined) };
  let finish!: (value: Response) => void;
  const onRefreshFailure = vi.fn(() => { throw new Error("PRIVATE_SENTINEL"); }), tasks: Promise<void>[] = [];
  const dependencies: DevelopmentReleaseDependencies = { fetch: vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })), verify: async () => undefined,
    cache, now: () => now, runtime: createDevelopmentReleaseRuntime(), onRefreshFailure };
  expect(await resolveRelease(devEnv, dependencies, task => tasks.push(task))).toEqual(seed);
  expect(onRefreshFailure).not.toHaveBeenCalled();
  finish(new Response(null, { status: 404 }));
  await Promise.all(tasks);
  expect(cache.match).toHaveBeenCalledTimes(2);
  expect(onRefreshFailure.mock.calls).toEqual([[{ phase: "discovery", reason: "http_error", http_status: 404 }]]);
  expect(await resolveRelease(devEnv, dependencies)).toEqual(seed);
  expect(cache.put).not.toHaveBeenCalled();
  expect(dependencies.runtime.cached?.verified_at_ms).toBe(stored.verified_at_ms);
});

it("keeps successful refreshes and cache hits quiet even when a newer candidate was rejected", async () => {
  const onRefreshFailure = vi.fn();
  const verify = vi.fn(async (descriptor: { package_version: string }) => {
    if (descriptor.package_version === devVersion(1)) throw new DevelopmentReleaseError("PRIVATE_SENTINEL", { phase: "verification", reason: "invalid_signature" });
  });
  const dependencies: DevelopmentReleaseDependencies = { fetch: responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z"), release(devVersion(1), "2026-09-16T09:00:00Z")]),
    verify, cache: undefined, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime(), onRefreshFailure };
  expect(await resolveRelease(devEnv, dependencies)).toMatchObject({ package_version: devVersion(0), distributable: true });
  expect(await resolveRelease(devEnv, dependencies)).toMatchObject({ package_version: devVersion(0), distributable: true });
  expect(verify).toHaveBeenCalledTimes(2); expect(onRefreshFailure).not.toHaveBeenCalled();
});

it("retains the newest candidate's failure when all candidates fail and classifies unknown exceptions without their messages", async () => {
  const onRefreshFailure = vi.fn();
  const dependencies: DevelopmentReleaseDependencies = { fetch: responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z"), release(devVersion(1), "2026-09-16T09:00:00Z")]),
    verify: async descriptor => {
      if (descriptor.package_version === devVersion(1)) throw new DevelopmentReleaseError("PRIVATE_SENTINEL", { phase: "verification", reason: "invalid_signature" });
      throw new Error("PRIVATE_SENTINEL");
    }, cache: undefined, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime(), onRefreshFailure };
  expect(await resolveRelease(devEnv, dependencies)).toMatchObject({ distributable: false });
  expect(onRefreshFailure.mock.calls).toEqual([[{ phase: "verification", reason: "invalid_signature" }]]);
  expect(developmentReleaseFailure(new Error("PRIVATE_SENTINEL"), "verification")).toEqual({ phase: "verification", reason: "unexpected" });
});

it("projects only fixed release diagnostic fields at the HTTP observability boundary", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const dependencies = developmentReleaseDependencies({ ...env, REGISTRY: {} } as never);
    dependencies.onRefreshFailure?.({ phase: "signature", reason: "http_error", http_status: 503, url: "PRIVATE_SENTINEL", message: "PRIVATE_SENTINEL" } as never);
    expect(warn.mock.calls).toEqual([[{ event: "dev_runner_release_refresh_failed", phase: "signature", reason: "http_error", http_status: 503 }]]);
    for (const value of [{ phase: "PRIVATE_SENTINEL", reason: "http_error" }, { phase: "signature", reason: "PRIVATE_SENTINEL" },
      { phase: { toString: () => "signature", secret: "PRIVATE_SENTINEL" }, reason: "http_error" }]) {
      expect(safeDevelopmentReleaseFailure(value)).toEqual({ phase: "discovery", reason: "unexpected" });
    }
    for (const http_status of ["503", 99, 600, 503.5, NaN]) expect(safeDevelopmentReleaseFailure({ phase: "discovery", reason: "http_error", http_status }))
      .toEqual({ phase: "discovery", reason: "http_error" });
    dependencies.onRefreshFailure?.({ phase: "discovery", reason: "http_error", http_status: 403, recovery: "failed",
      recovery_phase: "signature", recovery_reason: "http_error", recovery_http_status: 404, recovery_message: "PRIVATE_SENTINEL" } as never);
    expect(warn.mock.calls.at(-1)).toEqual([{ event: "dev_runner_release_refresh_failed", phase: "discovery", reason: "http_error", http_status: 403,
      recovery: "failed", recovery_phase: "signature", recovery_reason: "http_error", recovery_http_status: 404 }]);
    expect(safeDevelopmentReleaseFailure({ phase: "discovery", reason: "network_error", recovery: "failed", recovery_phase: "PRIVATE_SENTINEL", recovery_reason: "http_error" }))
      .toEqual({ phase: "discovery", reason: "network_error", recovery: "failed", recovery_phase: "discovery", recovery_reason: "unexpected" });
    expect(safeDevelopmentReleaseFailure({ phase: "discovery", reason: "network_error", recovery: "reverified", recovery_message: "PRIVATE_SENTINEL" }))
      .toEqual({ phase: "discovery", reason: "network_error", recovery: "reverified" });
  } finally { warn.mockRestore(); }
});

describe("reverification after a discovery outage", () => {
  function fixture(ageMs = 3_600_000) {
    const descriptor = developmentDescriptor(release(devVersion(42), "2026-10-05T23:35:06Z"))!;
    const state: { record: CachedDevelopmentReleaseRecord | undefined } = { record: { schema_version: 1, verified_at_ms: Date.now() - ageMs, descriptor } };
    const cache = { match: vi.fn(async () => state.record === undefined ? undefined : Response.json(state.record)),
      put: vi.fn(async (_request: Request, response: Response) => { state.record = await response.json(); }) };
    return { descriptor, state, cache };
  }

  it.each([403, 429, 500, 503, "network"] as const)("reverifies an expired immutable candidate after discovery %s before renewing its timestamp", async failure => {
    vi.useFakeTimers();
    const f = fixture(), oldTimestamp = f.state.record!.verified_at_ms;
    let finish!: () => void, settled = false;
    const verify = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const fetchImpl = vi.fn(async () => { if (failure === "network") throw new TypeError("synthetic network failure"); return new Response(null, { status: failure }); });
    const onRefreshFailure = vi.fn();
    const dependencies = { fetch: fetchImpl, verify, cache: f.cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime(), onRefreshFailure };
    const pending = resolveRelease(devEnv, dependencies).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(300);
    expect(verify).toHaveBeenCalledExactlyOnceWith(f.descriptor, expect.any(Function));
    expect(settled).toBe(false);
    expect(f.cache.put).not.toHaveBeenCalled();
    expect(f.state.record!.verified_at_ms).toBe(oldTimestamp);
    finish();
    expect(await pending).toEqual(f.descriptor);
    expect(f.state.record!.verified_at_ms).toBe(Date.now());
    expect(f.state.record!.descriptor.published_at).toBe(f.descriptor.published_at);
    expect(f.cache.put).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onRefreshFailure.mock.calls).toEqual([[{ ...(failure === "network" ? { phase: "discovery", reason: "network_error" }
      : { phase: "discovery", reason: "http_error", http_status: failure }), recovery: "reverified" }]]);
  });

  it.each(["future", "invalid", "missing", "soft stale"] as const)("never treats a %s cache as an expired candidate", async kind => {
    vi.useFakeTimers();
    const f = fixture(kind === "future" ? -60_000 : kind === "soft stale" ? 120_000 : 3_600_000);
    if (kind === "missing") f.state.record = undefined;
    if (kind === "invalid") f.state.record = { ...f.state.record!, descriptor: { ...f.descriptor, signature_url: "https://untrusted.invalid/manifest.sig" } };
    const timestamp = f.state.record?.verified_at_ms, verify = vi.fn(async () => undefined);
    const pending = resolveRelease(devEnv, { fetch: responseFetch({}, 403), verify, cache: f.cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() });
    await vi.advanceTimersByTimeAsync(20_500);
    expect(await pending).toMatchObject({ distributable: kind === "soft stale" });
    expect(verify).not.toHaveBeenCalled();
    expect(f.cache.put).not.toHaveBeenCalled();
    expect(f.state.record?.verified_at_ms).toBe(timestamp);
  });

  it.each(["not found", "malformed", "no candidate", "candidate verification"] as const)("does not reverify an expired record after %s discovery", async failure => {
    vi.useFakeTimers();
    const f = fixture(), verify = vi.fn<DevelopmentReleaseVerifier>(async () => { throw new DevelopmentReleaseError("synthetic invalid signature", { phase: "verification", reason: "invalid_signature" }); });
    const fetchImpl = responseFetch(failure === "malformed" ? {} : failure === "candidate verification" ? [release(devVersion(43), "2026-10-06T00:00:00Z")] : [], failure === "not found" ? 404 : 200);
    const pending = resolveRelease(devEnv, { fetch: fetchImpl, verify, cache: f.cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() });
    await vi.advanceTimersByTimeAsync(20_500);
    expect(await pending).toMatchObject({ distributable: false });
    expect(verify.mock.calls.every(([descriptor]) => descriptor.package_version === devVersion(43))).toBe(true);
    expect(verify).toHaveBeenCalledTimes(failure === "candidate verification" ? 1 : 0);
    expect(f.cache.put).not.toHaveBeenCalled();
  });

  it.each(["valid", "tampered", "incompatible"] as const)("runs the complete signature and manifest verifier on a %s expired candidate", async mode => {
    const f = fixture(), target = installerReleaseTarget(f.descriptor.package_version, "dev");
    const manifest = { schema_version: 1, project: "runmesh", version: target.version, tag: target.tag, channel: "dev", prerelease: true,
      commit_sha: "a".repeat(40), protocol_min: mode === "incompatible" ? 3 : 2, protocol_max: mode === "incompatible" ? 3 : 2,
      published_at: "2026-10-05T21:12:59Z", artifacts: [{ name: target.artifact_name, platform: "node", architecture: "portable", node_major_min: 22, url: target.artifact_url, size: 123, sha256: "b".repeat(64) }] };
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const toBase64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, bytes));
    const trust = { key_id: "test-dev-key", public_key_pem: `-----BEGIN PUBLIC KEY-----\n${toBase64(publicKey)}\n-----END PUBLIC KEY-----\n` };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/")) return new Response(null, { status: 403 });
      if (url === target.manifest_url) return new Response(mode === "tampered" ? JSON.stringify({ ...manifest, commit_sha: "c".repeat(40) }) : bytes);
      if (url === target.signature_url) return new Response(toBase64(signature));
      if (url === target.signature_descriptor_url) return Response.json({ schema_version: 1, algorithm: "ed25519", key_id: trust.key_id, encoding: "base64", signed_file: "manifest.json" });
      throw new Error("unexpected release request");
    });
    let verificationSettled = false;
    const verify = vi.fn<DevelopmentReleaseVerifier>(async (descriptor, fetcher) => {
      try { await verifyDevelopmentRunnerRelease(descriptor, fetcher, trust); }
      finally { verificationSettled = true; }
    });
    const onRefreshFailure = vi.fn();
    vi.useFakeTimers();
    const pending = resolveRelease(devEnv, { fetch: fetchImpl, verify, cache: f.cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime(), onRefreshFailure });
    await vi.waitFor(() => expect(verificationSettled).toBe(true));
    await vi.advanceTimersByTimeAsync(20_500);
    expect(await pending).toMatchObject({ distributable: mode === "valid" });
    expect(verify).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.filter(([input]) => !String(input).startsWith("https://api.github.com/")).map(([input]) => input))
      .toEqual([target.manifest_url, target.signature_url, target.signature_descriptor_url]);
    expect(f.cache.put).toHaveBeenCalledTimes(mode === "valid" ? 1 : 0);
    expect(onRefreshFailure.mock.calls).toEqual([[{ phase: "discovery", reason: "http_error", http_status: 403,
      ...(mode === "valid" ? { recovery: "reverified" } : { recovery: "failed", recovery_phase: "verification", recovery_reason: mode === "tampered" ? "invalid_signature" : "invalid_manifest" }) }]]);
  });

  it("prefers a freshly discovered release to an expired candidate", async () => {
    const f = fixture(), verify = vi.fn(async () => undefined);
    const result = await resolveRelease(devEnv, { fetch: responseFetch([release(devVersion(43), "2026-10-06T00:00:00Z")]), verify,
      cache: f.cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() });
    expect(result.package_version).toBe(devVersion(43));
    expect(verify).toHaveBeenCalledExactlyOnceWith(result, expect.any(Function));
  });

  it("returns the newer Registry winner when an older candidate finishes revalidation last", async () => {
    vi.useFakeTimers();
    const f = fixture(), newer = developmentDescriptor(release(devVersion(43), "2026-10-06T00:00:00Z"))!;
    let finish!: () => void;
    const verify = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    // The real Registry's monotonic-version guard owns the cross-isolate CAS.
    f.cache.put.mockImplementation(async () => undefined);
    const runtime = createDevelopmentReleaseRuntime();
    const pending = resolveRelease(devEnv, { fetch: responseFetch({}, 403), verify, cache: f.cache, now: () => Date.now(), runtime });
    await vi.advanceTimersByTimeAsync(300);
    f.state.record = { schema_version: 1, verified_at_ms: Date.now(), descriptor: newer };
    await vi.advanceTimersByTimeAsync(1);
    finish();
    expect(await pending).toEqual(newer);
    expect(runtime.cached?.descriptor).toEqual(newer);
    expect(runtime.cached?.verified_at_ms).toBe(f.state.record.verified_at_ms);
  });

  it("cannot let a late revalidation overwrite a newer refresh in the same runtime", async () => {
    vi.useFakeTimers();
    const f = fixture(), runtime = createDevelopmentReleaseRuntime();
    let now = Date.now(), finish!: () => void, calls = 0;
    const fetchImpl = vi.fn(async () => ++calls <= 3 ? new Response(null, { status: 403 }) : Response.json([release(devVersion(43), "2026-10-06T00:00:00Z")]));
    const verify = vi.fn<DevelopmentReleaseVerifier>(async descriptor => {
      if (descriptor.package_version === f.descriptor.package_version) await new Promise<void>(resolve => { finish = resolve; });
    });
    const dependencies = { fetch: fetchImpl, verify, cache: f.cache, now: () => now, runtime };
    const older = resolveRelease(devEnv, dependencies);
    await vi.advanceTimersByTimeAsync(300);
    now += 20_001;
    const newer = await resolveRelease(devEnv, dependencies);
    finish();
    expect(newer.package_version).toBe(devVersion(43));
    expect(await older).toEqual(newer);
    expect(runtime.cached?.descriptor).toEqual(newer);
    expect(f.cache.put).toHaveBeenCalledOnce();
  });

  it("keeps a newer runtime commit when fallback readback finishes late", async () => {
    vi.useFakeTimers();
    const f = fixture(), runtime = createDevelopmentReleaseRuntime();
    let now = Date.now(), finishRead!: (response: Response) => void;
    const olderRecord = f.state.record!;
    f.cache.match.mockImplementationOnce(async () => Response.json(olderRecord))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishRead = resolve; }));
    let calls = 0;
    const fetchImpl = vi.fn(async () => ++calls <= 3 ? new Response(null, { status: 403 }) : Response.json([release(devVersion(44), "2026-10-06T00:00:00Z")]));
    const dependencies = { fetch: fetchImpl, verify: async () => undefined, cache: f.cache, now: () => now, runtime };
    const older = resolveRelease(devEnv, dependencies);
    await vi.advanceTimersByTimeAsync(300);
    expect(f.cache.match).toHaveBeenCalledTimes(2);
    now += 60_001;
    const newer = await resolveRelease(devEnv, dependencies);
    const middle = developmentDescriptor(release(devVersion(43), "2026-10-06T00:00:00Z"))!;
    finishRead(Response.json({ schema_version: 1, verified_at_ms: now, descriptor: middle }));
    expect(newer.package_version).toBe(devVersion(44));
    expect(await older).toEqual(newer);
    expect(runtime.cached?.descriptor).toEqual(newer);
    expect(f.state.record?.descriptor).toEqual(newer);
  });

  it.each(["normal", "fallback"] as const)("returns a newer runtime commit after a late %s cache write exhausts the readback budget", async mode => {
    vi.useFakeTimers();
    const f = fixture(), runtime = createDevelopmentReleaseRuntime();
    let now = Date.now(), elapsed = 0, finishWrite!: () => void, calls = 0;
    const performanceClock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const put = f.cache.put.getMockImplementation()!;
    f.cache.put.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; })).mockImplementation(put);
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (mode === "fallback" && calls <= 3) return new Response(null, { status: 403 });
      return Response.json([release(devVersion(mode === "normal" && calls === 1 ? 42 : 43), "2026-10-06T00:00:00Z")]);
    });
    const dependencies = { fetch: fetchImpl, verify: async () => undefined, cache: f.cache, now: () => now, runtime };
    const older = resolveRelease(devEnv, dependencies);
    try {
      await vi.advanceTimersByTimeAsync(300);
      expect(f.cache.put).toHaveBeenCalledOnce();
      now += 60_001;
      elapsed = 20_001;
      const newer = await resolveRelease(devEnv, dependencies);
      finishWrite();
      expect(newer.package_version).toBe(devVersion(43));
      expect(await older).toEqual(newer);
      expect(runtime.cached?.descriptor).toEqual(newer);
      expect(f.cache.match).toHaveBeenCalledTimes(mode === "fallback" ? 3 : 2);
    } finally { finishWrite?.(); await older; performanceClock.mockRestore(); }
  });

  it("reads the Registry winner after verification and persistence spend the network budget", async () => {
    vi.useFakeTimers();
    const f = fixture(), runtime = createDevelopmentReleaseRuntime();
    const newer = developmentDescriptor(release(devVersion(43), "2026-10-06T00:00:00Z"))!;
    let elapsed = 0;
    const performanceClock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    f.cache.put.mockImplementation(async () => {
      elapsed = 21_000;
      // Another isolate's completed release wins the Registry's version guard.
      f.state.record = { schema_version: 1, verified_at_ms: Date.now(), descriptor: newer };
    });
    try {
      const pending = resolveRelease(devEnv, { fetch: responseFetch({}, 403), verify: async () => { elapsed = 19_000; },
        cache: f.cache, now: () => Date.now(), runtime });
      await vi.advanceTimersByTimeAsync(300);
      expect(await pending).toEqual(newer);
      expect(runtime.cached?.descriptor).toEqual(newer);
      expect(f.cache.match).toHaveBeenCalledTimes(2);
      expect(f.cache.put).toHaveBeenCalledOnce();
    } finally { performanceClock.mockRestore(); }
  });

  it("shares the original discovery deadline with asset revalidation", async () => {
    vi.useFakeTimers();
    const f = fixture(), timeouts: number[] = [], assetSignals: AbortSignal[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      timeouts.push(ms);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("synthetic deadline", "TimeoutError")), ms);
      return controller.signal;
    });
    let calls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).startsWith("https://api.github.com/")) {
        if (++calls === 1) await new Promise(resolve => setTimeout(resolve, 19_000));
        return new Response(null, { status: 403 });
      }
      const signal = init!.signal!;
      assetSignals.push(signal);
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const verify: DevelopmentReleaseVerifier = (descriptor, fetcher) => verifyDevelopmentRunnerRelease(descriptor, fetcher);
    try {
      const pending = resolveRelease(devEnv, { fetch: fetchImpl, verify, cache: f.cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() });
      await vi.advanceTimersByTimeAsync(19_500);
      expect(assetSignals).toHaveLength(1);
      expect(assetSignals[0]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(assetSignals[0]!.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toMatchObject({ distributable: false });
      expect(timeouts.filter(ms => ms === 20_000)).toHaveLength(1);
      expect(f.cache.put).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); vi.clearAllTimers(); }
  });
});
