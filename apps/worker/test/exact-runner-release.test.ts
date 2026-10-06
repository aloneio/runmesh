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
