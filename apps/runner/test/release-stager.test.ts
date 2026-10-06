import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { exactRunnerRelease } from "@aloneio/runmesh-protocol";
import { runnerArchiveFiles } from "../src/updates/release-archive.js";
import { downloadRunnerReleaseAsset, stageRunnerRelease } from "../src/updates/release-stager.js";

function archive(entries: { name: string; value: string; type?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.value); const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8"); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
    header.fill(32, 148, 156); header[156] = (entry.type ?? "0").charCodeAt(0); header.write("ustar\0", 257);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(parts));
}
function fixture(version = "0.1.6", policy: { protocolMin?: unknown; protocolMax?: unknown; nodeMajor?: number } = {}) {
  const release = exactRunnerRelease(version);
  const bytes = archive([{ name: "package/package.json", value: JSON.stringify({ name: "@aloneio/runmesh-runner", version, dependencies: {} }) },
    { name: "package/dist/runmesh.cjs", value: `console.log(${JSON.stringify(version)});` }]);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const manifest = Buffer.from(JSON.stringify({ schema_version: 1, project: "runmesh", version, tag: release.tag, channel: release.channel,
    prerelease: release.channel === "dev", commit_sha: "a".repeat(40), protocol_min: policy.protocolMin ?? 2, protocol_max: policy.protocolMax ?? 2, published_at: "2026-10-06T00:00:00Z",
    artifacts: [{ name: release.artifact_name, platform: "node", architecture: "portable", node_major_min: policy.nodeMajor ?? 22, url: release.artifact_url, size: bytes.length, sha256: sha }] }));
  const key = generateKeyPairSync("ed25519");
  const trust = { key_id: "test-release", public_key_pem: key.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const payload = new Map<string, Uint8Array>([[release.manifest_url, manifest], [release.signature_url, Buffer.from(sign(null, manifest, key.privateKey).toString("base64"))],
    [release.signature_descriptor_url, Buffer.from(JSON.stringify({ schema_version: 1, algorithm: "ed25519", key_id: trust.key_id, encoding: "base64", signed_file: "manifest.json" }))], [release.artifact_url, bytes]]);
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url)); expect(init?.redirect).toBe("manual"); expect(init?.credentials).toBe("omit");
    const value = payload.get(String(url)); return new Response(value === undefined ? null : Uint8Array.from(value), { status: value === undefined ? 404 : 200 });
  }) as typeof fetch;
  return { release, bytes, payload, fetchImpl, trust, calls, sha, manifestSha: createHash("sha256").update(manifest).digest("hex") };
}

describe("Runner exact release staging", () => {
  it("installs a signed older version beside the current installation and keeps state untouched", async () => {
    const f = fixture(); const root = await mkdtemp(join(tmpdir(), "runmesh-stager-"));
    try {
      await mkdir(join(root, "state"));
      await writeFile(join(root, "profile.json"), "existing credentials\n");
      await writeFile(join(root, "state", "job.json"), "existing job history\n");
      const result = await stageRunnerRelease({ version: "0.1.6", channel: "stable", artifact_sha256: f.sha, manifest_sha256: f.manifestSha },
        { installRoot: root, operationId: "downgrade-1", runtimePath: process.execPath, fetch: f.fetchImpl }, { trust: f.trust });
      expect(result).toMatchObject({ version: "0.1.6", artifactSha256: f.sha, manifestSha256: f.manifestSha });
      expect((await readdir(root)).sort()).toEqual(["profile.json", "state", "versions"]);
      expect(await readFile(join(root, "profile.json"), "utf8")).toBe("existing credentials\n");
      expect(await readFile(join(root, "state", "job.json"), "utf8")).toBe("existing job history\n");
      expect(JSON.parse(await readFile(join(result.versionDirectory, ".runmesh-release.json"), "utf8"))).toMatchObject({ version: "0.1.6" });
      expect(f.calls).toHaveLength(4);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);
  it("rejects an asset changed after selection before extracting any files", async () => {
    const f = fixture(); const root = await mkdtemp(join(tmpdir(), "runmesh-stager-"));
    try {
      await expect(stageRunnerRelease({ version: "0.1.6", channel: "stable", artifact_sha256: f.sha, manifest_sha256: "b".repeat(64) },
        { installRoot: root, operationId: "changed-release", runtimePath: process.execPath, fetch: f.fetchImpl }, { trust: f.trust })).rejects.toThrow("changed after");
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("does not accept a downloaded key as its trust root", async () => {
    const f = fixture(); const root = await mkdtemp(join(tmpdir(), "runmesh-stager-"));
    try {
      await expect(stageRunnerRelease({ version: "0.1.6", channel: "stable", artifact_sha256: f.sha, manifest_sha256: f.manifestSha },
        { installRoot: root, operationId: "untrusted", runtimePath: process.execPath, fetch: f.fetchImpl })).rejects.toThrow("signature descriptor");
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects corrupted package bytes after validating the signed metadata", async () => {
    const f = fixture(); f.payload.set(f.release.artifact_url, Buffer.from("tampered")); const root = await mkdtemp(join(tmpdir(), "runmesh-stager-"));
    try {
      await expect(stageRunnerRelease({ version: "0.1.6", channel: "stable", artifact_sha256: f.sha, manifest_sha256: f.manifestSha },
        { installRoot: root, operationId: "corrupt", runtimePath: process.execPath, fetch: f.fetchImpl }, { trust: f.trust })).rejects.toThrow("checksum");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("blocks untrusted redirects and oversized responses", async () => {
    await expect(downloadRunnerReleaseAsset("https://github.com/example", 16, (async () => new Response(null, { status: 302, headers: { location: "https://example.com/private" } })) as typeof fetch)).rejects.toThrow("origin");
    await expect(downloadRunnerReleaseAsset("https://github.com/example", 16, (async () => new Response("x".repeat(17))) as typeof fetch)).rejects.toThrow("size");
  });

  it("stages a cloud-selected signed wire v3 release independently of the manager's older wire protocol", async () => {
    const f = fixture("0.1.8-dev.99", { protocolMin: 3, protocolMax: 3 }); const root = await mkdtemp(join(tmpdir(), "runmesh-stager-"));
    try {
      const result = await stageRunnerRelease({ version: f.release.version, channel: "dev", artifact_sha256: f.sha, manifest_sha256: f.manifestSha },
        { installRoot: root, operationId: "wire-v3", runtimePath: process.execPath, fetch: f.fetchImpl }, { trust: f.trust });
      expect(result).toMatchObject({ version: f.release.version, manifestSha256: f.manifestSha, artifactSha256: f.sha });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);

  it.each([{ protocolMin: 0, protocolMax: 3 }, { protocolMin: 4, protocolMax: 3 }, { protocolMin: 2.5, protocolMax: 3 }, { protocolMin: "3", protocolMax: 3 }, { protocolMin: 3, protocolMax: Number.MAX_SAFE_INTEGER + 1 }])("rejects an invalid signed protocol range %j before extraction", async policy => {
    const f = fixture("0.1.6", policy); const root = await mkdtemp(join(tmpdir(), "runmesh-stager-"));
    try {
      await expect(stageRunnerRelease({ version: "0.1.6", channel: "stable", artifact_sha256: f.sha, manifest_sha256: f.manifestSha },
        { installRoot: root, operationId: "invalid-wire", runtimePath: process.execPath, fetch: f.fetchImpl }, { trust: f.trust })).rejects.toThrow("protocol range");
      expect(await readdir(root)).toEqual([]); expect(f.calls).toHaveLength(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retains the private Node runtime compatibility gate for a cloud-selected release", async () => {
    const f = fixture("0.1.6", { nodeMajor: Number(process.versions.node.split(".")[0]) + 1 }); const root = await mkdtemp(join(tmpdir(), "runmesh-stager-"));
    try {
      await expect(stageRunnerRelease({ version: "0.1.6", channel: "stable", artifact_sha256: f.sha, manifest_sha256: f.manifestSha },
        { installRoot: root, operationId: "future-node", runtimePath: process.execPath, fetch: f.fetchImpl }, { trust: f.trust })).rejects.toThrow("Node runtime");
      expect(await readdir(root)).toEqual([]); expect(f.calls).toHaveLength(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["manifest_sha256", "artifact_sha256"] as const)("requires the cloud-selected %s before fetching a release", async missing => {
    const f = fixture(); const target = { version: "0.1.6", channel: "stable" as const, artifact_sha256: f.sha, manifest_sha256: f.manifestSha };
    const { [missing]: _missing, ...withoutDigest } = target;
    await expect(stageRunnerRelease(withoutDigest, { installRoot: "unused", operationId: "unpinned", runtimePath: process.execPath, fetch: f.fetchImpl }, { trust: f.trust })).rejects.toThrow("both selected digests");
    expect(f.calls).toEqual([]);
  });
});

describe("Runner package extraction", () => {
  it.each(["package/../outside", "package/dist/../../outside", "package/C:/escape", "package/dist\\escape", "package/NUL", "package/file."])("rejects %s", name => {
    expect(() => runnerArchiveFiles(archive([{ name, value: "payload" }]))).toThrow("path");
  });
  it.each(["1", "2", "3", "4", "6"])("rejects tar type %s", type => {
    expect(() => runnerArchiveFiles(archive([{ name: "package/dist/runmesh.cjs", value: "", type }]))).toThrow("special file");
  });
  it("rejects aliases and files used as parents", () => {
    expect(() => runnerArchiveFiles(archive([{ name: "package/A", value: "1" }, { name: "package/a", value: "2" }]))).toThrow("duplicate");
    expect(() => runnerArchiveFiles(archive([{ name: "package/dir", value: "1" }, { name: "package/dir/a", value: "2" }]))).toThrow("overlaps");
  });
});
