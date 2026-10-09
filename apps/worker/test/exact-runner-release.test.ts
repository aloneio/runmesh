import { expect, it, vi } from "vitest";
import { resolveExactRunnerRelease } from "../src/distribution/exact-release.js";
import { developmentReleaseFailure } from "../src/distribution/release-io.js";
import fixture from "./fixtures/runner-release-0.1.6.json";

// Public immutable release bytes, preserved exactly so workerd exercises the
// production trust key and Ed25519 implementation without live network access.
const files: Record<string, string> = fixture.files;
function assetFetch(replace?: (name: string) => Response | undefined): typeof fetch {
  return vi.fn(async input => {
    const name = new URL(String(input)).pathname.split("/").at(-1)!;
    return replace?.(name) ?? new Response(files[name] ?? null, { status: files[name] === undefined ? 404 : 200 });
  }) as typeof fetch;
}

it("verifies the historical signed release in workerd and freezes its exact hashes", async () => {
  const result = await resolveExactRunnerRelease("0.1.6", assetFetch());
  expect(result).toMatchObject({ package_version: "0.1.6", channel: "stable", protocol: { min_version: 2, max_version: 2 },
    artifact_sha256: "85874bc677fe9026160a02fc5aaabed099266501813fd76f133725f5f298e261" });
  expect(result.manifest_sha256).toBe("da6a85ee8752d54fa2c45785f4b9fac8e3cfdbea29ec2291263e5c8c1163c33f");
});

it.each([
  ["manifest.json", "manifest"],
  ["manifest.sig", "signature"],
  ["manifest.signature.json", "signature_descriptor"],
] as const)("attributes malformed %s responses to their download phase", async (name, phase) => {
  const fetchImpl = assetFetch(requested => requested === name ? new Response("", { headers: { "content-length": "invalid" } }) : undefined);
  const error = await resolveExactRunnerRelease("0.1.6", fetchImpl).catch(error => error);
  expect(developmentReleaseFailure(error)).toEqual({ phase, reason: "invalid_response" });
});

it("preserves the HTTP failure status without including downloaded text", async () => {
  const fetchImpl = assetFetch(name => name === "manifest.sig" ? new Response("PRIVATE_PROVIDER_RESPONSE", { status: 404 }) : undefined);
  const error = await resolveExactRunnerRelease("0.1.6", fetchImpl).catch(error => error);
  expect(developmentReleaseFailure(error)).toEqual({ phase: "signature", reason: "http_error", http_status: 404 });
});

it("distinguishes signature failure from signed manifest incompatibility", async () => {
  const tampered = assetFetch(name => name === "manifest.json" ? new Response(`${files[name]} `) : undefined);
  const signatureError = await resolveExactRunnerRelease("0.1.6", tampered).catch(error => error);
  expect(developmentReleaseFailure(signatureError)).toEqual({ phase: "verification", reason: "invalid_signature" });
  const manifestError = await resolveExactRunnerRelease("0.1.7", assetFetch()).catch(error => error);
  expect(developmentReleaseFailure(manifestError)).toEqual({ phase: "verification", reason: "invalid_manifest" });
});

it.each(["headers", "body"] as const)("shares one exact-release deadline across sequential asset %s", async phase => {
  vi.useFakeTimers();
  const timeouts: number[] = [], signals: AbortSignal[] = [];
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    timeouts.push(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("synthetic deadline", "TimeoutError")), ms);
    return controller.signal;
  });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const name = new URL(String(input)).pathname.split("/").at(-1)!;
    const signal = init!.signal!;
    signals.push(signal);
    const bytes = new TextEncoder().encode(files[name]);
    if (phase === "body") return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const timer = setTimeout(() => { signal.removeEventListener("abort", stop); controller.enqueue(bytes); controller.close(); }, 9_000);
        const stop = () => { clearTimeout(timer); controller.error(signal.reason); };
        signal.addEventListener("abort", stop, { once: true });
      },
    }));
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(new Response(bytes)); }, 9_000);
      const stop = () => { clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener("abort", stop, { once: true });
    });
  });
  let outcome: unknown;
  const pending = resolveExactRunnerRelease("0.1.6", fetchImpl).then(value => { outcome = value; }, error => { outcome = developmentReleaseFailure(error); });
  try {
    await vi.advanceTimersByTimeAsync(19_999);
    expect(signals).toHaveLength(3);
    expect(signals[2]!.aborted).toBe(false);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(301);
    expect(outcome).toEqual({ phase: "signature_descriptor", reason: "timeout" });
    expect(signals[2]!.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(timeouts.filter(ms => ms === 20_000)).toHaveLength(1);
  } finally {
    await vi.advanceTimersByTimeAsync(40_000); await pending;
    timeout.mockRestore(); vi.clearAllTimers(); vi.useRealTimers();
  }
});
