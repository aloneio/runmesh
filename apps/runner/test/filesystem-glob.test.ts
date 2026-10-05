import { build } from "esbuild";
import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { PathPolicy } from "../src/path-policy.js";

const workspaceId = "glob-test";
async function fixture(files: Record<string, string>) {
  const base = await mkdtemp(join(tmpdir(), "runmesh-glob-"));
  const root = join(base, "workspace");
  await mkdir(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const service = new FilesystemService(new PathPolicy([{ workspaceId, rootPath: await realpath(root), readonly: true, shell: false }]));
  return { root, service, cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

const files = { "root.txt": "needle", "src/nested.txt": "needle", "src/deep/final.txt": "needle", "src/other.md": "needle" };
function paths(result: Record<string, unknown>): string[] {
  return (result.results as { path: string }[]).map(item => item.path).sort();
}

describe("public filesystem glob search", () => {
  it.each([
    { pattern: "*.txt", expected: ["root.txt", "src/deep/final.txt", "src/nested.txt"] },
    { pattern: "**/*.txt", expected: ["root.txt", "src/deep/final.txt", "src/nested.txt"] },
    { pattern: "src/*.txt", expected: ["src/nested.txt"] },
    { pattern: "src/**/*.txt", expected: ["src/deep/final.txt", "src/nested.txt"] },
    { pattern: "src/**", expected: ["src/deep/final.txt", "src/nested.txt", "src/other.md"] },
    { pattern: "nested.txt", expected: ["src/nested.txt"] },
    { pattern: "src\\*.txt", expected: ["src/nested.txt"] },
  ])("includes $pattern with path and basename semantics", async ({ pattern, expected }) => {
    const f = await fixture(files);
    try {
      const result = await f.service.search({ workspace_id: workspaceId, query: "needle", include_globs: [pattern] });
      expect(paths(result)).toEqual(expected);
      expect(result.truncated).toBe(false);
    } finally { await f.cleanup(); }
  });

  it("excludes basename patterns throughout nested directories", async () => {
    const f = await fixture(files);
    try {
      expect(paths(await f.service.search({ workspace_id: workspaceId, query: "needle", exclude_globs: ["*.txt"] }))).toEqual(["src/other.md"]);
    } finally { await f.cleanup(); }
  });

  it("matches one Unicode character with ?", async () => {
    const f = await fixture({ "😀.txt": "needle", "中.txt": "needle", "ab.txt": "needle", "src/🚀.txt": "needle" });
    try {
      expect(paths(await f.service.search({ workspace_id: workspaceId, query: "needle", include_globs: ["?.txt"] }))).toEqual(["src/🚀.txt", "中.txt", "😀.txt"]);
    } finally { await f.cleanup(); }
  });

  it("keeps punctuation literal and platform case behavior", async () => {
    const f = await fixture({ "src/[a]+(b).TXT": "needle", "src/ab.txt": "needle" });
    try {
      const result = await f.service.search({ workspace_id: workspaceId, query: "needle", include_globs: ["[a]+(b).txt"] });
      expect(paths(result)).toEqual(process.platform === "win32" ? ["src/[a]+(b).TXT"] : []);
      expect(paths(await f.service.search({ workspace_id: workspaceId, query: "needle", include_globs: ["[a]+(b).TXT"] }))).toEqual(["src/[a]+(b).TXT"]);
    } finally { await f.cleanup(); }
  });

  it("keeps nested ignore rules, directory suffixes and negation", async () => {
    const f = await fixture({
      ".gitignore": "ignored/\n!ignored/keep.txt\n/root-only.txt\n",
      "ignored/drop.txt": "needle", "ignored/keep.txt": "needle", "file/ignored": "needle",
      "root-only.txt": "needle", "sub/root-only.txt": "needle", "sub/.gitignore": "*.log\n!keep.log\n",
      "sub/drop.log": "needle", "sub/keep.log": "needle", "sibling/drop.log": "needle",
    });
    try {
      expect(paths(await f.service.search({ workspace_id: workspaceId, query: "needle" }))).toEqual([
        "file/ignored", "ignored/keep.txt", "sibling/drop.log", "sub/keep.log", "sub/root-only.txt",
      ]);
    } finally { await f.cleanup(); }
  });

  it("keeps stable glob-bound cursors and rejects changed patterns", async () => {
    const f = await fixture(files);
    try {
      const input = { workspace_id: workspaceId, query: "needle", include_globs: ["*.txt"], max_results: 1 };
      const first = await f.service.search(input);
      expect(first.next_snapshot_cursor).toEqual(expect.any(String));
      const next = await f.service.search({ ...input, include_globs: ["*.txt"], cursor: first.next_snapshot_cursor });
      expect(next.snapshot_id).toBe(first.snapshot_id);
      expect(paths(next)).not.toEqual(paths(first));
      await expect(f.service.search({ ...input, include_globs: ["**/*.txt"], cursor: first.next_snapshot_cursor })).rejects.toMatchObject({ code: "search_snapshot_changed" });
    } finally { await f.cleanup(); }
  });

  it.skipIf(process.platform === "win32")("matches newline names with ** and applies ignore rules across newline directories", async () => {
    const f = await fixture({
      ".gitignore": "**/drop.txt\n", "plain.txt": "needle",
      "line\nbreak/keep\nname.txt": "needle", "line\nbreak/drop.txt": "needle",
    });
    try {
      const input = { workspace_id: workspaceId, query: "needle", include_globs: ["**/*.txt"] };
      expect(paths(await f.service.search(input))).toEqual(["line\nbreak/keep\nname.txt", "plain.txt"]);
      expect(paths(await f.service.search({ ...input, exclude_globs: ["**/keep*.txt"] }))).toEqual(["plain.txt"]);
    } finally { await f.cleanup(); }
  });
});

describe("glob resource bounds through public search", () => {
  let bundleRoot: string;
  let childFile: string;
  beforeAll(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), "runmesh-glob-child-"));
    childFile = join(bundleRoot, "search.mjs");
    await build({
      stdin: { contents: `
        import { FilesystemService } from './src/filesystem.ts';
        import { PathPolicy } from './src/path-policy.ts';
        const [rootPath, kind, pattern] = process.argv.slice(2);
        const service = new FilesystemService(new PathPolicy([{ workspaceId: 'glob-test', rootPath, readonly: true, shell: false }]));
        process.send({ ready: true });
        const result = await service.search({ workspace_id: 'glob-test', query: 'a', mode: 'filename',
          ...(kind === 'include' ? { include_globs: [pattern] } : kind === 'exclude' ? { exclude_globs: [pattern] } : {}) });
        process.send({ result });
        process.disconnect();
      `, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "glob-search.ts", loader: "ts" },
      bundle: true, format: "esm", platform: "node", target: "node22", outfile: childFile,
    });
  });
  afterAll(async () => { if (bundleRoot !== undefined) await rm(bundleRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

  it.each(["include", "exclude", "ignore", "long-ignore"])("completes overlapping stars in %s rules", async kind => {
    const pattern = (kind === "long-ignore" ? "**/".repeat(20_000) : "") + "*a".repeat(14) + "b";
    const path = "a".repeat(80) + ".txt";
    const f = await fixture({ [path]: "needle", ...(kind.endsWith("ignore") ? { ".gitignore": pattern + "\n" } : {}) });
    try {
      // A parent watchdog remains runnable if a future matcher blocks the
      // child event loop. Start its search budget after module loading.
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const child = fork(childFile, [f.root, kind, kind === "long-ignore" ? "" : pattern], { execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
        let timedOut = false;
        let response: Record<string, unknown> | undefined;
        let errors = "";
        const stop = (): void => { timedOut = true; child.kill("SIGKILL"); };
        let timer = setTimeout(stop, 10_000);
        child.stderr?.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
        child.on("message", (message: { ready?: boolean; result?: Record<string, unknown> }) => {
          if (message.ready) { clearTimeout(timer); timer = setTimeout(stop, 3_000); }
          if (message.result !== undefined) response = message.result;
        });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => {
          clearTimeout(timer);
          if (timedOut) reject(new Error("public search exceeded its matcher watchdog"));
          else if (code !== 0 || response === undefined) reject(new Error(`search child failed: ${errors}`));
          else resolve(response);
        });
      });
      expect(paths(result)).toEqual(kind === "include" ? [] : [path]);
      expect(result.truncated).toBe(false);
    } finally { await f.cleanup(); }
  });
});
