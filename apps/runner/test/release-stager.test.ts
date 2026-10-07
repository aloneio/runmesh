import { describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { exactRunnerRelease } from "@aloneio/runmesh-protocol";
import { runnerArchiveFiles } from "../src/updates/release-archive.js";
import { downloadRunnerReleaseAsset, stageRunnerRelease } from "../src/updates/release-stager.js";

const cleanupFault = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const remove: typeof actual.rm = async (path, options) => {
    if (cleanupFault.error !== undefined && String(path).endsWith(".staging")) throw cleanupFault.error;
    return actual.rm(path, options);
  };
  return { ...actual, rm: remove };
});

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
function fixture(version = "0.1.6", policy: { protocolMin?: unknown; protocolMax?: unknown; nodeMajor?: number; bundle?: string } = {}) {
  const release = exactRunnerRelease(version);
  const bytes = archive([{ name: "package/package.json", value: JSON.stringify({ name: "@aloneio/runmesh-runner", version, dependencies: {} }) },
    { name: "package/dist/runmesh.cjs", value: policy.bundle ?? `console.log(${JSON.stringify(version)});` }]);
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

  it("does not fetch a release after maintenance has stopped", async () => {
    const controller = new AbortController(), reason = new Error("maintenance stopped");
    controller.abort(reason);
    const fetchImpl = vi.fn(async () => new Response("release"));
    await expect(downloadRunnerReleaseAsset("https://github.com/example", 16, fetchImpl, controller.signal)).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cancels a pending release body when maintenance stops", async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), reason = new Error("maintenance stopped");
    const cancel = vi.fn();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { streamController = value; }, cancel });
    const downloading = downloadRunnerReleaseAsset("https://github.com/example", 16, (async () => new Response(body)) as typeof fetch, controller.signal);
    let result: unknown;
    const settled = downloading.then(value => { result = value; }, error => { result = error; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(body.locked).toBe(true);
      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toBe(reason);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (cancel.mock.calls.length === 0) streamController.close();
      await settled;
      vi.useRealTimers();
    }
  });

  it("cancels a response that arrives after its release request was stopped", async () => {
    const controller = new AbortController(), reason = new Error("maintenance stopped"), cancel = vi.fn();
    let respond!: (response: Response) => void;
    let requestSignal: AbortSignal | null | undefined;
    const downloading = downloadRunnerReleaseAsset("https://github.com/example", 16, (async (_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>(resolve => { respond = resolve; });
    }) as typeof fetch, controller.signal);
    const result = downloading.catch(error => error);
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
    const body = new ReadableStream<Uint8Array>({ cancel });
    respond(new Response(body));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(body.locked).toBe(false);
  });

  it("releases a stalled body after the download deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ cancel });
    const result = downloadRunnerReleaseAsset("https://github.com/example", 16, (async () => new Response(body)) as typeof fetch).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(30000);
      expect(await result).toMatchObject({ message: "Runner release download timed out." });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("stops before fetching another asset or creating an installation after cancellation", async () => {
    const f = fixture(), controller = new AbortController(), reason = new Error("maintenance stopped");
    const root = await mkdtemp(join(tmpdir(), "runmesh-stager-"));
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await f.fetchImpl(url, init);
      controller.abort(reason);
      return response;
    };
    try {
      await expect(stageRunnerRelease({ version: "0.1.6", channel: "stable", artifact_sha256: f.sha, manifest_sha256: f.manifestSha },
        { installRoot: root, operationId: "cancelled", runtimePath: process.execPath, fetch: fetchImpl, signal: controller.signal }, { trust: f.trust })).rejects.toBe(reason);
      expect(f.calls).toEqual([f.release.manifest_url]);
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("stops an active version probe that ignores SIGTERM and removes the temporary installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runmesh-stager-")), marker = join(root, "probe-started");
    const f = fixture("0.1.6", { bundle: `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);` });
    const controller = new AbortController();
    const staging = stageRunnerRelease({ version: "0.1.6", channel: "stable", artifact_sha256: f.sha, manifest_sha256: f.manifestSha },
      { installRoot: root, operationId: "cancelled-probe", runtimePath: process.execPath, fetch: f.fetchImpl, signal: controller.signal }, { trust: f.trust });
    const result = staging.then(value => value, error => error);
    let probePid: number | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toMatch(/^\d+$/u), { timeout: 5000 });
      probePid = Number(await readFile(marker, "utf8"));
      controller.abort();
      const outcome = await Promise.race([result, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Version probe did not stop after cancellation.")), 2000); })]);
      expect(outcome).toMatchObject({ name: "AbortError" });
      expect(await readdir(join(root, "versions"))).toEqual([]);
      expect(() => process.kill(probePid!, 0)).toThrow();
      probePid = undefined;
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      controller.abort();
      if (probePid !== undefined) { try { process.kill(probePid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
      await result;
      await rm(root, { recursive: true, force: true });
    }
  }, 10000);

  it("retains the staging failure and cleanup error when removing its temporary installation fails", async () => {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), "runmesh-stager-"));
    const cleanup = new Error("temporary installation cleanup fixture");
    cleanupFault.error = cleanup;
    try {
      const failure = await stageRunnerRelease({ version: "0.1.6", channel: "stable", artifact_sha256: f.sha, manifest_sha256: f.manifestSha },
        { installRoot: root, operationId: "cleanup-failure", runtimePath: join(root, "missing-runtime"), fetch: f.fetchImpl }, { trust: f.trust }).catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.cause).toMatchObject({ code: "ENOENT", syscall: "lstat" });
      expect(failure.errors).toEqual([failure.cause, cleanup]);
    } finally { cleanupFault.error = undefined; await rm(root, { recursive: true, force: true }); }
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
