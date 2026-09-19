import type { DevelopmentReleaseCache, DevelopmentReleaseRefreshScheduler, DevelopmentReleaseVerifier, DevelopmentReleaseDependencies, RunnerReleaseEnvironment } from "../src/contracts/runner-release.js";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import { developmentReleaseDependencies, registryDevelopmentReleaseCache } from "../src/http/release-cache.js";
import { describe, expect, it, vi } from "vitest";
import { discoverDevelopmentRunnerRelease as discoverRelease, resolveRunnerReleaseDescriptor as resolveRelease, createDevelopmentReleaseRuntime, verifyDevelopmentRunnerRelease } from "../src/distribution/release.js";
import { FIXED_RELEASE_VERSION, installerReleaseTarget, renderPosixInstaller, renderPowerShellInstaller } from "../src/installer.js";
import { runnerInstallScript, runnerRelease } from "../src/http/distribution.js";

// Each call models a new isolate, with the real runtime algorithm enabled.
function discoverDevelopmentRunnerRelease(fetchImpl: typeof fetch, verify: DevelopmentReleaseVerifier, cache?: DevelopmentReleaseCache | null, schedule?: DevelopmentReleaseRefreshScheduler) {
  return discoverRelease({ fetch: fetchImpl, verify, cache: cache ?? undefined, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() }, schedule);
}
function resolveRunnerReleaseDescriptor(environment: RunnerReleaseEnvironment, fetchImpl: typeof fetch) {
  return resolveRelease(environment, { fetch: fetchImpl, verify: verifyDevelopmentRunnerRelease, cache: undefined, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() });
}

// Derive fixtures independently from the reviewed stable core, so a release
// bump exercises the same next-patch contract instead of stale dev tags.
const [releaseMajor, releaseMinor, releasePatch] = FIXED_RELEASE_VERSION.split(".");
const devCore = `${releaseMajor}.${releaseMinor}.${Number(releasePatch) + 1}`;
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

describe("development Runner distribution", () => {
  it("selects the newest complete immutable dev prerelease and ignores unsafe candidates", async () => {
    const fetchImpl = responseFetch([
      release(devVersion(0), "2026-09-16T08:00:00Z"),
      release("0.1.0-dev.5", "2026-09-16T14:00:00Z"),
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

  it("rejects prereleases from the old baseline and a later patch core", async () => {
    for (const version of [`${FIXED_RELEASE_VERSION}-dev.0`, `${releaseMajor}.${releaseMinor}.${Number(releasePatch) + 2}-dev.0`]) {
      const verify = vi.fn(async () => undefined);
      await expect(discoverDevelopmentRunnerRelease(responseFetch([release(version, "2026-09-16T08:00:00Z")]), verify)).rejects.toThrow("no immutable signed development Runner release");
      expect(verify).not.toHaveBeenCalled();
    }
  });

  it("verifies the dev manifest with Ed25519 before advertising the release", async () => {
    const metadataFetch = responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]);
    const descriptor = await discoverDevelopmentRunnerRelease(metadataFetch, async () => undefined);
    const target = installerReleaseTarget(devVersion(0), "dev");
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
    await expect(discoverDevelopmentRunnerRelease(malformedOffline, async () => undefined, cache)).rejects.toThrow("development release discovery failed");
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
    const cache = { match: async () => Response.json({ schema_version: 1, verified_at_ms: Date.now() - age, descriptor: seed }), put: vi.fn(async () => undefined) };
    const tasks: Promise<void>[] = [];
    await expect(discoverDevelopmentRunnerRelease(responseFetch([], 404), async () => undefined, cache, task => { tasks.push(task); })).rejects.toThrow();
    expect(tasks).toHaveLength(0);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("rechecks the hard expiry after a slow persistent-cache read", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release(devVersion(0), "2026-09-16T08:00:00Z")]), async () => undefined, null);
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const cache = {
      match: async () => { clock.mockReturnValue(started + 2_000); return Response.json({ schema_version: 1, verified_at_ms: started - 3_599_000, descriptor: seed }); },
      put: vi.fn(async () => undefined),
    };
    const schedule = vi.fn();
    try {
      await expect(discoverDevelopmentRunnerRelease(responseFetch([], 404), async () => undefined, cache, schedule)).rejects.toThrow();
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
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporary", { status: 503 })));
    try {
      const releaseResponse = await runnerRelease(new Request("https://runmeshdev.example/runner/releases/dev"), devEnv as never, "dev");
      expect(releaseResponse.headers.get("cache-control")).toBe("no-store");
      expect(await releaseResponse.json()).toMatchObject({ channel: "dev", distributable: false });

      const installerResponse = await runnerInstallScript(new Request("https://runmeshdev.example/runner/install.sh"), new URL("https://runmeshdev.example/runner/install.sh"), devEnv as never);
      expect(installerResponse.headers.get("cache-control")).toBe("no-store");
      expect(await installerResponse.text()).toContain("Development never falls back to the stable Runner");
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
  it("reserves one cold refresh before cache I/O and shares only the completed descriptor", async () => {
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) };
    const verify = vi.fn(async () => undefined);
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify, cache, now: () => Date.now(), runtime: createDevelopmentReleaseRuntime() };
    const first = discoverRelease(dependencies);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const concurrent = await Promise.allSettled(Array.from({ length: 20 }, () => discoverRelease(dependencies)));
    expect(concurrent.every(result => result.status === "rejected")).toBe(true);
    expect(cache.match).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Object.values(dependencies.runtime).some(value => value instanceof Promise)).toBe(false);
    finish(Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")]));
    const descriptor = await first;
    expect(await Promise.all(Array.from({ length: 20 }, () => discoverRelease(dependencies)))).toEqual(Array(20).fill(descriptor));
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated failed cold refreshes and recovers after a short in-memory cooldown", async () => {
    let now = Date.now();
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json([]))
      .mockImplementation(async () => Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")])) as typeof fetch;
    const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) };
    const dependencies: DevelopmentReleaseDependencies = { fetch: fetchImpl, verify: async () => undefined, cache, now: () => now, runtime: createDevelopmentReleaseRuntime() };
    for (let round = 0; round < 2; round++) {
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => discoverRelease(dependencies)));
      expect(results.every(result => result.status === "rejected")).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(cache.match).toHaveBeenCalledTimes(1);
      expect(cache.put).not.toHaveBeenCalled();
    }
    now += 5_001;
    expect((await discoverRelease(dependencies)).package_version).toBe(devVersion(1));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("renews an owned reservation after slow cache I/O for the complete network refresh budget", async () => {
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
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    try {
      const concurrent = await Promise.allSettled(Array.from({ length: 20 }, () => discoverRelease(dependencies)));
      expect(concurrent.every(result => result.status === "rejected")).toBe(true);
      now += 19_999;
      await expect(discoverRelease(dependencies)).rejects.toThrow("refresh temporarily unavailable");
      expect(cache.match).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledOnce();
      finishRefresh(Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")]));
      expect((await first).package_version).toBe(devVersion(1));
      expect(cache.put).toHaveBeenCalledOnce();
    } finally {
      finishRefresh(Response.json([release(devVersion(1), "2026-09-16T09:00:00Z")]));
      await first.catch(() => undefined);
    }
  });

  it("isolates discovery values and cooldowns by Registry binding", async () => {
    const firstBinding = {}, secondBinding = {};
    const first = developmentReleaseDependencies(null, firstBinding);
    expect(developmentReleaseDependencies(null, firstBinding).runtime).toBe(first.runtime);
    const second = developmentReleaseDependencies(null, secondBinding);
    expect(second.runtime).not.toBe(first.runtime);
    await expect(discoverRelease({ ...first, fetch: responseFetch([], 404), verify: async () => undefined })).rejects.toThrow();
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
