import { assertSupportedNodeVersion } from "../src/version.js";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { it, expect } from "vitest";
import { encodeWireFrame, PROTOCOL_CURRENT_VERSION, type JsonValue } from "@aloneio/runmesh-protocol";
import { PathPolicy } from "../src/path-policy.js";
import { PatchService } from "../src/patch-service.js";
import { FilesystemService } from "../src/filesystem.js";
import { fitPrefix } from "../src/git-service.js";
import { jsonBytes, MAX_RPC_RESULT_BYTES } from "../src/rpc-budget.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runmesh-ga-")));
  const policy = new PathPolicy([{ workspaceId: "ga", rootPath: root, readonly: false, shell: false }]);
  return { root, policy, patch: new PatchService(policy), fs: new FilesystemService(policy), cleanup: () => rm(root, { recursive: true, force: true }) };
}
const patch = (text: string) => `*** Begin Patch\n${text}\n*** End Patch`;
const frame = (result: unknown) => encodeWireFrame({ type: "rpc.response", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "r".repeat(128), result: result as JsonValue });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

it("GA-001: add/update/move/delete successful results are wire-safe independent JSON trees", async () => {
  const f = await fixture();
  try {
    for (const text of ["*** Add File: a.txt\n+old", "*** Update File: a.txt\n@@\n-old\n+new", "*** Update File: a.txt\n*** Move to: b.txt\n@@\n-new\n+renamed", "*** Delete File: b.txt"]) {
      const result = await f.patch.apply({ workspace_id: "ga", patch: patch(text) });
      expect(() => frame(result)).not.toThrow();
      expect(jsonBytes(result)).toBeLessThanOrEqual(MAX_RPC_RESULT_BYTES);
    }
    expect(await readdir(f.root)).toEqual([]);
  } finally { await f.cleanup(); }
});

it("GA-002: oversized aggregate success metadata is rejected BEFORE any file is written", async () => {
  const f = await fixture();
  try {
    const dir = Array.from({ length: 4 }, (_, i) => `${i}${"d".repeat(180)}`).join("/");
    await mkdir(join(f.root, dir), { recursive: true });
    const text = patch(Array.from({ length: 128 }, (_, i) => `*** Add File: ${dir}/${i}.txt\n+x`).join("\n"));
    await expect(f.patch.apply({ workspace_id: "ga", patch: text })).rejects.toMatchObject({ code: "file_too_large" });
    expect(await readdir(join(f.root, dir))).toEqual([]);
  } finally { await f.cleanup(); }
});

it("deleting the trailing lines of a file preserves the preceding line's newline", async () => {
  const f = await fixture();
  try {
    // The preceding line was followed by more content in the original, so it
    // still ends with a newline even though the removal shortened the file.
    await writeFile(join(f.root, "trailing.txt"), "x\na\nb\n");
    await f.patch.apply({ workspace_id: "ga", patch: patch("*** Update File: trailing.txt\n@@\n-a\n-b") });
    expect(await readFile(join(f.root, "trailing.txt"), "utf8")).toBe("x\n");

    // Same when the original file had no trailing newline of its own.
    await writeFile(join(f.root, "unterminated.txt"), "x\na\nb");
    await f.patch.apply({ workspace_id: "ga", patch: patch("*** Update File: unterminated.txt\n@@\n-a\n-b") });
    expect(await readFile(join(f.root, "unterminated.txt"), "utf8")).toBe("x\n");

    // A non-empty replacement still owns the trailing newline.
    await writeFile(join(f.root, "replace.txt"), "a\nb\n");
    await f.patch.apply({ workspace_id: "ga", patch: patch("*** Update File: replace.txt\n@@\n-b\n+c") });
    expect(await readFile(join(f.root, "replace.txt"), "utf8")).toBe("a\nc\n");
    await f.patch.apply({ workspace_id: "ga", patch: patch("*** Update File: replace.txt\n@@\n-c\n+d\n\\ No newline at end of file") });
    expect(await readFile(join(f.root, "replace.txt"), "utf8")).toBe("a\nd");

    // Removing every line still yields an empty file rather than a stray newline.
    await writeFile(join(f.root, "empty.txt"), "a\nb\n");
    await f.patch.apply({ workspace_id: "ga", patch: patch("*** Update File: empty.txt\n@@\n-a\n-b") });
    expect(await readFile(join(f.root, "empty.txt"), "utf8")).toBe("");
  } finally { await f.cleanup(); }
});

it("GA-003: status truncation keeps the largest fitting prefix in logarithmic checks", () => {
  const entries = Array.from({ length: 4096 }, (_, index) => index);
  const checks: number[] = [];
  const kept = fitPrefix(entries, (prefix) => { checks.push(prefix.length); return prefix.length <= 1000; });
  expect(kept).toBe(1000);
  // A quadratic pop loop would need ~3096 whole-response serializations here;
  // binary search over 4097 candidate lengths needs at most 13 probes.
  expect(checks.length).toBeLessThanOrEqual(13);
  expect(fitPrefix(entries, () => true)).toBe(entries.length);
  expect(fitPrefix(entries, () => false)).toBe(0);
});

it("GA-003: CJK and escaped search pages remain wire-safe and paginate without losing matches", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 10; i++) await writeFile(join(f.root, `${i}.txt`), (`needle${"中".repeat(4080)}\n`).repeat(10));
    let cursor: string | undefined; const matches = new Set<string>();
    for (let pages = 0; pages < 110; pages++) {
      const result = await f.fs.search({ workspace_id: "ga", query: "needle", max_results: 256, ...(cursor === undefined ? {} : { cursor }) });
      expect(() => frame(result)).not.toThrow();
      expect(jsonBytes(result)).toBeLessThanOrEqual(MAX_RPC_RESULT_BYTES);
      for (const item of result.results as { path: string; line: number }[]) { const key = `${item.path}:${item.line}`; expect(matches.has(key)).toBe(false); matches.add(key); }
      if (result.next_cursor === null) break;
      expect(Number(result.next_cursor)).toBeGreaterThan(Number(cursor ?? 0)); cursor = result.next_cursor as string;
    }
    expect(matches.size).toBe(100);
  } finally { await f.cleanup(); }
});

it("GA-003: direct UTF-8 reads budget JSON escaping and advance to EOF", async () => {
  const f = await fixture();
  try {
    const text = ("\u0001😀\\\"").repeat(30000);
    await writeFile(join(f.root, "escaped.txt"), text);
    let cursor = "0"; let collected = "";
    for (let pages = 0; pages < 200; pages++) {
      const result = await f.fs.read({ workspace_id: "ga", path: "escaped.txt", cursor, limit: 262144 });
      expect(() => frame(result)).not.toThrow(); expect(jsonBytes(result)).toBeLessThanOrEqual(MAX_RPC_RESULT_BYTES);
      collected += result.data;
      if (result.next_cursor === null) break;
      expect(Number(result.next_cursor)).toBeGreaterThan(Number(cursor)); cursor = result.next_cursor as string;
    }
    expect(collected).toBe(text);
  } finally { await f.cleanup(); }
});

it("GA-015: concurrent same-baseline commits yield one success and one clean conflict, with no backup residue", async () => {
  const f = await fixture();
  try {
    for (let trial = 0; trial < 8; trial++) {
      await writeFile(join(f.root, "same.txt"), "old\n");
      let arrived = 0; let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
      const options = { beforeCommit: async () => { if (++arrived === 2) release(); await barrier; } };
      const services = [new PatchService(f.policy, options), new PatchService(f.policy, options)];
      const results = await Promise.allSettled(services.map((service, i) => service.apply({ workspace_id: "ga", expected_hashes: { "same.txt": sha("old\n") }, patch: patch(`*** Update File: same.txt\n@@\n-old\n+new${i}`) })));
      expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      const failure = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
      expect(failure.reason.code).toBe("baseline_changed");
      expect(await readdir(f.root)).toEqual(["same.txt"]);
      expect(await readFile(join(f.root, "same.txt"), "utf8")).toMatch(/^new[01]\n$/);
    }
  } finally { await f.cleanup(); }
});

it("GA-004 rejects EOL/old runtime floors and accepts tested LTS lines", () => {
  for (const value of ["20.19.2", "22.19.0", "22.23.1", "23.0.0", "24.20.0", "26.0.0", "invalid"]) expect(() => assertSupportedNodeVersion(value)).toThrow();
  for (const value of ["22.23.2", "22.24.0", "24.21.0", "24.22.0"]) expect(() => assertSupportedNodeVersion(value)).not.toThrow();
});
