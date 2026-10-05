import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { PathPolicy } from "../src/path-policy.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

async function fixture(content: Buffer, chunkSize: number, stopAfter = Number.POSITIVE_INFINITY, afterRead?: (file: string, policy: PathPolicy) => void | Promise<void>) {
  const root = await actual.realpath(await actual.mkdtemp(join(tmpdir(), "runmesh-stat-sample-")));
  const file = join(root, "sample.bin");
  await actual.writeFile(file, content);
  const policy = new PathPolicy([{ workspaceId: "test", rootPath: root, readonly: true, shell: false }]);
  const service = new FilesystemService(policy);
  let readCalls = 0;
  let bytesRead = 0;
  let closed = false;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (String(path) === file) {
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        readCalls += 1;
        if (bytesRead >= stopAfter) return { bytesRead: 0, buffer };
        const result = await read(buffer, offset, Math.min(length, chunkSize), position);
        bytesRead += result.bytesRead;
        if (readCalls === 1) await afterRead?.(file, policy);
        return result;
      }) as typeof handle.read;
      handle.close = async () => { await close(); closed = true; };
    }
    return handle;
  });
  return {
    stat: () => service.stat({ workspace_id: "test", path: "sample.bin" }),
    observation: () => ({ readCalls, bytesRead, closed }),
    cleanup: async () => {
      vi.mocked(fs.open).mockImplementation(actual.open);
      await actual.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

describe.sequential("filesystem stat sampling", () => {
  it.each([
    ["UTF-8 characters split across short reads", Buffer.from("中文😀"), 1, false],
    ["NUL after a short text prefix", Buffer.from([0x61, 0x62, 0, 0x63]), 2, true],
    ["invalid UTF-8 after a short text prefix", Buffer.from([0x61, 0x62, 0xff, 0x63]), 2, true],
    ["incomplete UTF-8 at actual EOF", Buffer.from([0x61, 0x62, 0xe4, 0xb8]), 2, true],
    ["UTF-8 split at the bounded sample edge", Buffer.from("a".repeat(4095) + "中tail"), 257, false],
    ["binary content within the bounded sample", Buffer.concat([Buffer.alloc(4000, 0x61), Buffer.from([0]), Buffer.alloc(1000, 0x61)]), 257, true],
    ["binary content beyond the bounded sample", Buffer.concat([Buffer.alloc(4096, 0x61), Buffer.from([0])]), 257, false],
    ["empty file", Buffer.alloc(0), 1, false],
  ] as const)("classifies %s", async (_name, content, chunkSize, binary) => {
    const test = await fixture(content, chunkSize);
    try {
      await expect(test.stat()).resolves.toMatchObject({ type: "file", size: content.length, binary, encoding: binary ? "binary" : "utf-8" });
      expect(test.observation()).toMatchObject({ bytesRead: Math.min(content.length, 4096), closed: true });
      expect(test.observation().readCalls).toBeLessThanOrEqual(32);
    } finally { await test.cleanup(); }
  });

  it("reports an interrupted sample instead of classifying its prefix", async () => {
    const test = await fixture(Buffer.from("prefix and remainder"), 6, 6);
    try {
      await expect(test.stat()).rejects.toMatchObject({ code: "file_changed" });
      expect(test.observation()).toMatchObject({ readCalls: 2, bytesRead: 6, closed: true });
    } finally { await test.cleanup(); }
  });

  it("bounds repeated short reads and closes the descriptor", async () => {
    const test = await fixture(Buffer.alloc(4096, 0x61), 1);
    try {
      await expect(test.stat()).rejects.toMatchObject({ code: "read_budget_exhausted" });
      expect(test.observation()).toEqual({ readCalls: 32, bytesRead: 32, closed: true });
    } finally { await test.cleanup(); }
  });

  it("rejects a file changed while its sample is read", async () => {
    const test = await fixture(Buffer.from("before"), 6, Number.POSITIVE_INFINITY, async file => {
      await actual.writeFile(file, "after!");
      await actual.utimes(file, new Date(1000), new Date(1000));
    });
    try {
      await expect(test.stat()).rejects.toMatchObject({ code: "file_changed" });
      expect(test.observation().closed).toBe(true);
    } finally { await test.cleanup(); }
  });

  it("rechecks workspace access after sampling", async () => {
    const test = await fixture(Buffer.from("before"), 6, Number.POSITIVE_INFINITY, (_file, policy) => { policy.replace([]); });
    try {
      await expect(test.stat()).rejects.toMatchObject({ code: "stale_policy" });
      expect(test.observation().closed).toBe(true);
    } finally { await test.cleanup(); }
  });
});
