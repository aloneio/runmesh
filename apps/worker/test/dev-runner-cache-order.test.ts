import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { developmentDescriptor, DEV_RELEASE_STALE_MS } from "../src/domain/release-selection.js";
import { internalHeaders } from "../src/security.js";

const path = "/distribution/dev-runner-release";
const key = "distribution:verified-dev-runner-release:v1";
const secret = "test-internal-control-secret-not-for-production";
function cached(version: string, verifiedAt: number) {
  const descriptor = developmentDescriptor({ tag_name: `v${version}`, draft: false, prerelease: true, immutable: true, published_at: "2026-09-16T08:00:00Z",
    assets: ["LICENSE", "NOTICE", "SHA256SUMS", "THIRD_PARTY_NOTICES.md", "manifest.json", "manifest.sig", "manifest.signature.json", "trust-keyring.json", `runmesh-runner-${version}.tgz`].map(name => ({ name })) });
  expect(descriptor).toBeDefined();
  return { schema_version: 1, verified_at_ms: verifiedAt, descriptor: descriptor! };
}

it.each([
  ["0.1.9-dev.42", 1_000, false],
  ["0.1.8-dev.43", -1_000, false],
  ["0.1.8-dev.43", 0, false],
  ["0.1.8-dev.43", 1_000, true],
  ["0.1.9-dev.43", 1_000, false],
  ["0.1.7-dev.44", -1_000, true],
] as const)("orders verified release %s with time offset %s before writing shared cache", async (version, offset, replaces) => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`dev-cache-order-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const current = cached("0.1.8-dev.43", Date.now() - 2_000);
    const candidate = cached(version, current.verified_at_ms + offset);
    const write = async (value: unknown) => {
      const body = JSON.stringify(value);
      return instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", body, headers: await internalHeaders(secret, "POST", path, body) }));
    };
    expect((await write(current)).status).toBe(204);
    const put = vi.spyOn(state.storage, "put");
    try {
      expect((await write(candidate)).status).toBe(204);
      expect(put.mock.calls.filter(([storedKey]) => storedKey === key)).toHaveLength(replaces ? 1 : 0);
    } finally { put.mockRestore(); }
    const response = await instance.fetch(new Request(`https://registry.internal${path}`, { headers: await internalHeaders(secret, "GET", path, "") }));
    expect(await response.json()).toEqual(replaces ? candidate : current);
  });
});

it("rejects malformed newer release descriptors and replaces malformed stored cache", async () => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`dev-cache-validation-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const current = cached("0.1.8-dev.43", Date.now() - 2_000);
    await state.storage.put(key, current);
    const candidate = cached("0.1.8-dev.44", current.verified_at_ms + 1_000);
    const write = async (value: unknown) => {
      const body = JSON.stringify(value);
      return instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", body, headers: await internalHeaders(secret, "POST", path, body) }));
    };
    const invalid = { ...candidate, descriptor: { ...candidate.descriptor, artifact: { source: "https://invalid.example/runner.tgz" } } };
    expect((await write(invalid)).status).toBe(400);
    expect(await state.storage.get(key)).toEqual(current);
    await state.storage.put(key, { ...invalid, verified_at_ms: Date.now() });
    expect((await write(current)).status).toBe(204);
    expect(await state.storage.get(key)).toEqual(current);
  });
});

it.each([
  ["0.1.8-dev.44", DEV_RELEASE_STALE_MS - 1, true, 204],
  ["0.1.8-dev.44", DEV_RELEASE_STALE_MS, true, 400],
  ["0.1.8-dev.44", DEV_RELEASE_STALE_MS + 1, true, 400],
  ["0.1.8-dev.43", DEV_RELEASE_STALE_MS, true, 400],
  ["0.1.8-dev.44", DEV_RELEASE_STALE_MS, false, 400],
] as const)("checks the hard cache age for %s at %s ms with existing cache %s", async (version, age, hasCurrent, status) => {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName(`dev-cache-expiry-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance, state) => {
    const now = Date.now();
    const current = cached("0.1.8-dev.43", now - 2_000);
    if (hasCurrent) await state.storage.put(key, current);
    const candidate = cached(version, now - age);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const put = vi.spyOn(state.storage, "put");
    try {
      const body = JSON.stringify(candidate);
      const response = await instance.fetch(new Request(`https://registry.internal${path}`, { method: "POST", body,
        headers: await internalHeaders(secret, "POST", path, body) }));
      expect(response.status).toBe(status);
      expect(put.mock.calls.filter(([storedKey]) => storedKey === key)).toHaveLength(status === 204 ? 1 : 0);
      expect(await state.storage.get(key)).toEqual(status === 204 ? candidate : hasCurrent ? current : undefined);
    } finally { put.mockRestore(); clock.mockRestore(); }
  });
});
