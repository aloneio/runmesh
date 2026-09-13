import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { PathPolicy } from "../src/path-policy.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

async function fixture() {
  const base = await fs.mkdtemp(join(tmpdir(), "runmesh-filesystem-security-"));
  const root = join(base, "workspace"); const outside = join(base, "synthetic-outside");
  await fs.mkdir(root); await fs.mkdir(outside);
  const service = new FilesystemService(new PathPolicy([{ workspaceId: "test", rootPath: root, readonly: true, shell: false }]));
  return { base, root, outside, service, cleanup: async () => {
    vi.mocked(fs.open).mockImplementation(actual.open);
    vi.mocked(fs.opendir).mockImplementation(actual.opendir);
    await fs.rm(base, { recursive: true, force: true });
  } };
}

describe.sequential("filesystem security regressions", () => {
  it.each(["binary", "invalid-utf8"])("charges %s reads against the total byte budget", async (kind) => {
    const test = await fixture();
    try {
      for (let index = 0; index < 24; index += 1) await fs.writeFile(join(test.root, `${index}.dat`), Buffer.alloc(256 * 1024, kind === "binary" ? 0 : 255));
      let filesOpened = 0;
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        if (String(path).endsWith(".dat")) filesOpened += 1;
        return actual.open(path, flags, mode);
      });
      const result = await test.service.search({ workspace_id: "test", query: "absent" });
      expect(result.truncated).toBe(true);
      expect(result.results).toEqual([]);
      expect(filesOpened).toBeLessThanOrEqual(16);
      expect(filesOpened).toBeGreaterThan(0);
    } finally { await test.cleanup(); }
  });

  it("bounds scanning even when every file is empty", async () => {
    const test = await fixture();
    try {
      for (let index = 0; index < 1002; index += 1) await fs.writeFile(join(test.root, `${index}.empty`), "");
      let filesOpened = 0;
      vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
        if (String(path).endsWith(".empty")) filesOpened += 1;
        return actual.open(path, flags, mode);
      });
      const result = await test.service.search({ workspace_id: "test", query: "absent" });
      expect(result.truncated).toBe(true);
      expect(filesOpened).toBeLessThanOrEqual(1000);
    } finally { await test.cleanup(); }
  });

  it("supports bounded literal and filename search options with context and globs", async () => {
    const test = await fixture();
    try {
      await fs.mkdir(join(test.root, "src"));
      await fs.writeFile(join(test.root, "src", "Alpha.ts"), "before\nNeedle value\nafter\n");
      await fs.writeFile(join(test.root, "src", "other.md"), "needle markdown\n");
      const literal = await test.service.search({ workspace_id: "test", query: "needle", case_sensitive: false, include_globs: ["**/*.ts"], context_before: 1, context_after: 1 });
      expect(literal).toMatchObject({ engine: "builtin_literal", truncated: false, results: [{ path: "src/Alpha.ts", line: 2, column: 1, match: "Needle", context_before: [{ line: 1, text: "before" }], context_after: [{ line: 3, text: "after" }] }] });
      const filename = await test.service.search({ workspace_id: "test", query: "alpha", mode: "filename", case_sensitive: false });
      expect(filename).toMatchObject({ engine: "builtin_filename", results: [{ path: "src/Alpha.ts", match: "Alpha" }] });
    } finally { await test.cleanup(); }
  });

  it("honors nested gitignore rules including a bounded negation", async () => {
    const test = await fixture();
    try {
      await fs.mkdir(join(test.root, "sub"));
      await fs.writeFile(join(test.root, ".gitignore"), "sub/*.log\n");
      await fs.writeFile(join(test.root, "sub", ".gitignore"), "!keep.log\n");
      await fs.writeFile(join(test.root, "sub", "drop.log"), "gitignore-canary\n");
      await fs.writeFile(join(test.root, "sub", "keep.log"), "gitignore-canary\n");
      const result = await test.service.search({ workspace_id: "test", query: "gitignore-canary" });
      expect(result.results).toEqual([expect.objectContaining({ path: "sub/keep.log" })]);
    } finally { await test.cleanup(); }
  });

  it("binds continuation cursors to the bounded search snapshot", async () => {
    const test = await fixture();
    try {
      await fs.writeFile(join(test.root, "a.txt"), "cursor-canary-a\n");
      await fs.writeFile(join(test.root, "b.txt"), "cursor-canary-b\n");
      const first = await test.service.search({ workspace_id: "test", query: "cursor-canary", max_results: 1 });
      expect(first.next_cursor).toMatch(/^s1:[a-f0-9]{16}:1$/);
      await fs.writeFile(join(test.root, "b.txt"), "cursor-canary-c\n");
      await expect(test.service.search({ workspace_id: "test", query: "cursor-canary", max_results: 1, cursor: first.next_cursor })).rejects.toMatchObject({ code: "search_snapshot_changed" });
    } finally { await test.cleanup(); }
  });

  it.skipIf(process.platform !== "linux")("reads the pinned directory when its pathname is swapped away and restored around opendir", async () => {
    const test = await fixture();
    const path = join(test.root, "listing"); const held = join(test.root, "held");
    try {
      await fs.mkdir(path);
      await fs.writeFile(join(path, "inside-only.txt"), "synthetic inside");
      await fs.writeFile(join(test.outside, "outside-canary.txt"), "synthetic outside");
      let swapped = false;
      vi.mocked(fs.opendir).mockImplementation(async (openedPath, options) => {
        if (swapped) return actual.opendir(openedPath, options);
        swapped = true;
        await fs.rename(path, held); await fs.symlink(test.outside, path, "dir");
        try { return await actual.opendir(openedPath, options); }
        finally { await fs.unlink(path); await fs.rename(held, path); }
      });
      const result = await test.service.list({ workspace_id: "test", path: "listing" });
      expect(swapped).toBe(true);
      expect(result.entries).toEqual([{ name: "inside-only.txt", type: "file" }]);
    } finally { await test.cleanup(); }
  });

  it.skipIf(process.platform !== "linux")("rejects a different directory opened during an ABA replacement", async () => {
    const test = await fixture();
    const path = join(test.root, "listing"); const held = join(test.root, "held");
    try {
      await fs.mkdir(path);
      await fs.writeFile(join(test.outside, "outside-canary.txt"), "synthetic outside");
      let swapped = false;
      vi.mocked(fs.open).mockImplementation(async (openedPath, flags, mode) => {
        if (String(openedPath) !== path || swapped) return actual.open(openedPath, flags, mode);
        swapped = true;
        await fs.rename(path, held); await fs.rename(test.outside, path);
        try { return await actual.open(openedPath, flags, mode); }
        finally { await fs.rename(path, test.outside); await fs.rename(held, path); }
      });
      await expect(test.service.list({ workspace_id: "test", path: "listing" })).rejects.toThrow();
      expect(swapped).toBe(true);
    } finally { await test.cleanup(); }
  });
});
