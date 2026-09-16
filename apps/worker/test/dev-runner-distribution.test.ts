import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import { registryDevelopmentReleaseCache } from "../src/http/release-cache.js";
import { describe, expect, it, vi } from "vitest";
import { discoverDevelopmentRunnerRelease, resolveRunnerReleaseDescriptor, verifyDevelopmentRunnerRelease } from "../src/distribution/release.js";
import { FIXED_RELEASE_VERSION, installerReleaseTarget, renderPosixInstaller, renderPowerShellInstaller } from "../src/installer.js";
import { runnerInstallScript, runnerRelease } from "../src/http/distribution.js";

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
      release("0.1.4-dev.0", "2026-09-16T08:00:00Z"),
      release("0.1.0-dev.5", "2026-09-16T14:00:00Z"),
      release("0.1.4-dev.4", "2026-09-16T12:00:00Z", { immutable: false }),
      release("0.1.4-dev.3", "2026-09-16T11:00:00Z", { assets: [{ name: "manifest.json" }] }),
      release("0.1.4-dev.2", "2026-09-16T10:00:00Z", { draft: true }),
      release("0.1.4-dev.1", "2026-09-16T09:00:00Z"),
      { ...release("0.1.4-dev.9", "2026-09-16T13:00:00Z"), tag_name: "v0.1.4" },
    ]);
    const descriptor = await discoverDevelopmentRunnerRelease(fetchImpl, async () => undefined);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.github.com/repos/aloneio/runmesh/releases?per_page=20", expect.objectContaining({ redirect: "manual", cache: "no-store" }));
    expect(descriptor).toMatchObject({ channel: "dev", distributable: true, package_version: "0.1.4-dev.1" });
    expect(descriptor.package_spec).toBe("https://github.com/aloneio/runmesh/releases/download/v0.1.4-dev.1/runmesh-runner-0.1.4-dev.1.tgz");
  });

  it("verifies the dev manifest with Ed25519 before advertising the release", async () => {
    const metadataFetch = responseFetch([release("0.1.4-dev.0", "2026-09-16T08:00:00Z")]);
    const descriptor = await discoverDevelopmentRunnerRelease(metadataFetch, async () => undefined);
    const target = installerReleaseTarget("0.1.4-dev.0", "dev");
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
      return new Response(JSON.stringify([release("0.1.4-dev.0", "2026-09-16T08:00:00Z")]), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const descriptor = await discoverDevelopmentRunnerRelease(fetchImpl, async () => undefined);
    expect(calls).toBe(2);
    expect(descriptor).toMatchObject({ channel: "dev", distributable: true, package_version: "0.1.4-dev.0" });

    let forbiddenCalls = 0;
    const forbidden = vi.fn(async () => { forbiddenCalls += 1; return new Response("forbidden", { status: 403 }); }) as unknown as typeof fetch;
    await expect(discoverDevelopmentRunnerRelease(forbidden, async () => undefined)).rejects.toThrow("development release discovery failed");
    expect(forbiddenCalls).toBe(3);
  });

  it("uses only previously verified dev descriptors as the cross-isolate outage fallback", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release("0.1.4-dev.0", "2026-09-16T08:00:00Z")]), async () => undefined, null);
    let stored: Response | undefined = new Response(JSON.stringify({ schema_version: 1, verified_at_ms: Date.now(), descriptor: seed }));
    const cache = { match: vi.fn(async () => stored?.clone()), put: vi.fn(async (_request: Request, response: Response) => { stored = response.clone(); }) };
    const offline = responseFetch({ error: "offline" }, 503);
    const fresh = await discoverDevelopmentRunnerRelease(offline, async () => undefined, cache);
    expect(fresh).toMatchObject({ channel: "dev", package_version: "0.1.4-dev.0" });
    expect(offline).not.toHaveBeenCalled();

    stored = new Response(JSON.stringify({ schema_version: 1, verified_at_ms: Date.now() - 120_000, descriptor: seed }));
    const staleOffline = responseFetch({ error: "offline" }, 503);
    const stale = await discoverDevelopmentRunnerRelease(staleOffline, async () => undefined, cache);
    expect(stale).toMatchObject({ channel: "dev", package_version: "0.1.4-dev.0" });
    expect(staleOffline).toHaveBeenCalledTimes(3);

    stored = new Response(JSON.stringify({ schema_version: 1, verified_at_ms: Date.now(), descriptor: { ...seed, package_spec: "https://example.invalid/tampered.tgz" } }));
    const malformedOffline = responseFetch({ error: "offline" }, 503);
    await expect(discoverDevelopmentRunnerRelease(malformedOffline, async () => undefined, cache)).rejects.toThrow("development release discovery failed");
  });

  it("persists a dev descriptor only after its verifier succeeds", async () => {
    let stored: Response | undefined;
    const cache = { match: vi.fn(async () => stored?.clone()), put: vi.fn(async (_request: Request, response: Response) => { stored = response.clone(); }) };
    const fetchImpl = responseFetch([release("0.1.4-dev.0", "2026-09-16T08:00:00Z")]);
    const verifier = vi.fn(async () => undefined);
    const descriptor = await discoverDevelopmentRunnerRelease(fetchImpl, verifier, cache);
    expect(descriptor.package_version).toBe("0.1.4-dev.0");
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    const cached = await stored?.json() as { descriptor?: { package_version?: string } };
    expect(cached.descriptor?.package_version).toBe("0.1.4-dev.0");
  });

  it("returns a stale verified dev release without waiting for a slow upstream refresh", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release("0.1.4-dev.0", "2026-09-16T08:00:00Z")]), async () => undefined, null);
    let stored = new Response(JSON.stringify({ schema_version: 1, verified_at_ms: Date.now() - 120_000, descriptor: seed }));
    const cache = { match: async () => stored.clone(), put: vi.fn(async (_request: Request, value: Response) => { stored = value.clone(); }) };
    let finish!: (value: Response) => void;
    const slow = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })) as unknown as typeof fetch;
    const tasks: Promise<void>[] = [];
    const result = await discoverDevelopmentRunnerRelease(slow, async () => undefined, cache, task => { tasks.push(task); });
    expect(result.package_version).toBe("0.1.4-dev.0");
    expect(tasks).toHaveLength(1);
    expect(cache.put).not.toHaveBeenCalled();
    finish(new Response(JSON.stringify([release("0.1.4-dev.1", "2026-09-16T09:00:00Z")])));
    await Promise.all(tasks);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(await stored.json()).toMatchObject({ descriptor: { package_version: "0.1.4-dev.1" } });
  });

  it("failed or unverified refreshes never extend the original cached verification time", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release("0.1.4-dev.0", "2026-09-16T08:00:00Z")]), async () => undefined, null);
    const timestamp = Date.now() - 120_000;
    const cache = { match: async () => Response.json({ schema_version: 1, verified_at_ms: timestamp, descriptor: seed }), put: vi.fn(async () => undefined) };
    const tasks: Promise<void>[] = [];
    const invalid = responseFetch([release("0.1.4-dev.1", "2026-09-16T09:00:00Z")]);
    const result = await discoverDevelopmentRunnerRelease(invalid, async () => { throw new Error("invalid signature"); }, cache, task => { tasks.push(task); });
    expect(result.package_version).toBe(seed.package_version);
    await expect(Promise.all(tasks)).resolves.toEqual([undefined]);
    expect(cache.put).not.toHaveBeenCalled();
    expect(await (await cache.match()).json()).toMatchObject({ verified_at_ms: timestamp });
  });

  it.each([3_600_000, 3_600_001, -60_000])("does not serve expired or future-dated cache records (age=%s)", async age => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release("0.1.4-dev.0", "2026-09-16T08:00:00Z")]), async () => undefined, null);
    const cache = { match: async () => Response.json({ schema_version: 1, verified_at_ms: Date.now() - age, descriptor: seed }), put: vi.fn(async () => undefined) };
    const tasks: Promise<void>[] = [];
    await expect(discoverDevelopmentRunnerRelease(responseFetch([], 404), async () => undefined, cache, task => { tasks.push(task); })).rejects.toThrow();
    expect(tasks).toHaveLength(0);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("rechecks the hard expiry after a slow persistent-cache read", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release("0.1.4-dev.0", "2026-09-16T08:00:00Z")]), async () => undefined, null);
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
      release("0.1.4-dev.2", "2026-09-16T10:00:00Z"),
      release("0.1.4-dev.10", "2026-09-16T09:00:00Z"),
    ]), async () => undefined, null);
    expect(result.package_version).toBe("0.1.4-dev.10");
  });

  it("never reflects extra untrusted cache fields into a release descriptor", async () => {
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release("0.1.4-dev.0", "2026-09-16T08:00:00Z")]), async () => undefined, null);
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

    const fetchImpl = responseFetch([release("0.1.4-dev.0", "2026-09-16T08:00:00Z")]);
    const oldStableAcknowledgement = await resolveRunnerReleaseDescriptor({ ...devEnv, RUNMESH_SIGNED_RELEASE_AVAILABLE: FIXED_RELEASE_VERSION }, fetchImpl);
    expect(oldStableAcknowledgement).toMatchObject({ channel: "dev", distributable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("production remains pinned to the reviewed stable release without network discovery", async () => {
    const fetchImpl = responseFetch([release("0.1.4-dev.9", "2026-09-16T13:00:00Z")]);
    const descriptor = await resolveRunnerReleaseDescriptor({ RUNMESH_ENVIRONMENT: "production", RUNMESH_PUBLIC_ORIGIN: "https://runmesh.example", RUNMESH_SIGNED_RELEASE_AVAILABLE: FIXED_RELEASE_VERSION }, fetchImpl);
    expect(descriptor).toMatchObject({ channel: "stable", distributable: true, package_version: FIXED_RELEASE_VERSION });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renders a dev installer pinned to the discovered immutable tag and verifies dev manifest semantics", () => {
    const target = installerReleaseTarget("0.1.4-dev.0", "dev");
    const shell = renderPosixInstaller("https://runmeshdev.example", "privileged_host", target);
    const powershell = renderPowerShellInstaller("https://runmeshdev.example", "dedicated_user", target);
    for (const script of [shell, powershell]) {
      expect(script).toContain("0.1.4-dev.0");
      expect(script).toContain("releases/download/v0.1.4-dev.0");
      expect(script).toContain('manifest.channel !== "dev"');
      expect(script).toContain("manifest.prerelease !== true");
      expect(script).toContain("signature does not verify");
    }
    expect(() => installerReleaseTarget("0.1.4", "dev")).toThrow();
    expect(() => installerReleaseTarget("0.1.4-dev.01", "dev")).toThrow();
  });
  it("wires waitUntil through the public dev installer HTTP route", async () => {
    const runtimeEnv = { ...env, ...devEnv, RUNMESH_TEST_MODE: "" };
    const seed = await discoverDevelopmentRunnerRelease(responseFetch([release("0.1.4-dev.0", "2026-09-16T08:00:00Z")]), async () => undefined, null);
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
      expect(body).toContain("VERSION='0.1.4-dev.0'");
      expect(body).not.toContain("releases/download/v0.1.3/");
      expect(background).toHaveBeenCalled();
      finish(new Response("not found", { status: 404 }));
      await waitOnExecutionContext(ctx);
    } finally { if (finish !== undefined) finish(new Response("not found", { status: 404 })); await waitOnExecutionContext(ctx); vi.stubGlobal("fetch", originalFetch); }
  });

});
