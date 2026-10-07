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

async function fixture(content: string, afterRead?: (file: string, policy: PathPolicy) => Promise<void> | void, stopAfter = Number.POSITIVE_INFINITY) {
  const root = await actual.realpath(await actual.mkdtemp(join(tmpdir(), "runmesh-search-consistency-")));
  const file = join(root, "sample.txt");
  await actual.writeFile(file, content);
  await actual.utimes(file, new Date(1000), new Date(1000));
  const policy = new PathPolicy([{ workspaceId: "test", rootPath: root, readonly: true, shell: false }]);
  const service = new FilesystemService(policy);
  let readCalls = 0, bytesRead = 0, closed = false;
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    const handle = await actual.open(path, flags, mode);
    if (String(path) === file) {
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        readCalls += 1;
        if (bytesRead >= stopAfter) return { bytesRead: 0, buffer };
        const result = await read(buffer, offset, Math.min(length, 2), position);
        bytesRead += result.bytesRead;
        if (readCalls === 1) await afterRead?.(file, policy);
        return result;
      }) as typeof handle.read;
      handle.close = async () => { await close(); closed = true; };
    }
    return handle;
  });
  return {
    search: (query: string) => service.search({ workspace_id: "test", query }),
    observation: () => ({ readCalls, bytesRead, closed }),
    cleanup: async () => {
      vi.mocked(fs.open).mockImplementation(actual.open);
      await actual.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

describe.sequential("filesystem search read consistency", () => {
  it("does not report a match assembled from different file versions", async () => {
    const test = await fixture("neXXXX\n", async file => {
      await actual.writeFile(file, "XXedle\n");
      await actual.utimes(file, new Date(2000), new Date(2000));
    });
    try {
      // Neither complete version contains this word. Reading the old prefix
      // and the new suffix must not fabricate a search hit or cursor content.
      expect(await test.search("needle")).toMatchObject({ results: [], scanned: { bytes: 7 } });
      expect(test.observation()).toMatchObject({ bytesRead: 7, closed: true });
    } finally { await test.cleanup(); }
  });

  it("does not publish a prefix when the descriptor stops before its observed size", async () => {
    const test = await fixture("needle\n", undefined, 2);
    try {
      expect(await test.search("ne")).toMatchObject({ results: [], scanned: { bytes: 2 } });
      expect(test.observation()).toEqual({ readCalls: 2, bytesRead: 2, closed: true });
    } finally { await test.cleanup(); }
  });

  it("rechecks workspace access before publishing a completed file read", async () => {
    const test = await fixture("needle\n", (_file, policy) => { policy.replace([]); });
    try {
      expect(await test.search("needle")).toMatchObject({ results: [], scanned: { bytes: 7 } });
      expect(test.observation()).toMatchObject({ closed: true });
    } finally { await test.cleanup(); }
  });

  it("retains complete results across ordinary partial reads", async () => {
    const test = await fixture("needle\n");
    try {
      expect(await test.search("needle")).toMatchObject({
        results: [{ path: "sample.txt", line: 1, match: "needle", text: "needle" }], scanned: { bytes: 7 },
      });
      expect(test.observation()).toEqual({ readCalls: 4, bytesRead: 7, closed: true });
    } finally { await test.cleanup(); }
  });
});
