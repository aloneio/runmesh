import { expect, it } from "vitest";
import { exactRunnerRelease, MAX_RELEASE_ASSET_BYTES, releaseManifestProblem, verifyRunnerReleaseSignature } from "../src/index.js";

it("selects exact historical and development releases without changing channels", () => {
  expect(exactRunnerRelease("0.1.6")).toMatchObject({ channel: "stable", tag: "v0.1.6", artifact_url: "https://github.com/aloneio/runmesh/releases/download/v0.1.6/runmesh-runner-0.1.6.tgz" });
  expect(exactRunnerRelease("0.1.7-dev.123").channel).toBe("dev");
  for (const value of ["latest", "0.1.6/../../evil", "https://example.com", "01.1.6", "0.1.7-beta.1", "0.1.7-dev.01"]) expect(() => exactRunnerRelease(value)).toThrow();
});

it("uses protocol overlap for explicit selection while keeping the bootstrap contract exact", () => {
  const release = exactRunnerRelease("0.1.6");
  const manifest = { schema_version: 1, project: "runmesh", version: release.version, tag: release.tag, channel: release.channel, prerelease: false,
    commit_sha: "a".repeat(40), protocol_min: 1, protocol_max: 2, published_at: "2026-10-06T00:00:00Z",
    artifacts: [{ name: release.artifact_name, platform: "node", architecture: "portable", node_major_min: 22, url: release.artifact_url, size: 128, sha256: "b".repeat(64) }] };
  const target = { ...release, protocol_min: 2, protocol_max: 2, max_asset_bytes: MAX_RELEASE_ASSET_BYTES };
  expect(releaseManifestProblem(manifest, target)).toBe("manifest");
  expect(releaseManifestProblem(manifest, { ...target, compatibility: "overlap", node_major: 22 })).toBeUndefined();
  expect(releaseManifestProblem({ ...manifest, protocol_max: 1 }, { ...target, compatibility: "overlap", node_major: 22 })).toBe("manifest");
  expect(releaseManifestProblem({ ...manifest, protocol_min: 3 }, { ...target, compatibility: "overlap", node_major: 22 })).toBe("manifest");
});

it("verifies raw manifest bytes and rejects a tampered signature using Web Crypto", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const trust = { key_id: "test", public_key_pem: `-----BEGIN PUBLIC KEY-----\n${base64(publicBytes)}\n-----END PUBLIC KEY-----\n` };
  const encode = (value: string) => new TextEncoder().encode(value);
  const manifest = encode('{ "version": "0.1.6" }\n');
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, manifest));
  const descriptor = encode(JSON.stringify({ schema_version: 1, algorithm: "ed25519", key_id: "test", encoding: "base64", signed_file: "manifest.json" }));
  expect(await verifyRunnerReleaseSignature(manifest, encode(base64(signature)), descriptor, trust)).toEqual({ version: "0.1.6" });
  await expect(verifyRunnerReleaseSignature(encode('{"version":"0.1.6"}'), encode(base64(signature)), descriptor, trust)).rejects.toThrow("does not verify");
});
