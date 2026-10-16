import { expect, it, vi } from "vitest";
import { createGithubSkillSource } from "../src/platform/skills/github-source.js";
import { readGithubArchive } from "../src/platform/skills/github-archive.js";
import { readGithubTar } from "../src/platform/skills/github-tar.js";

const source = {
  repository: "https://github.com/example/skills",
  commit: "a".repeat(40),
  path: "software-copyright-materials",
};
const root = "skills-" + source.commit + "/", folder = root + source.path + "/";
const body = "---\nname: example\ndescription: Archive test\n---\n";
type Entry = { path: string; body?: string | Uint8Array; type?: string };

function header(path: string, type: string, size: number): Uint8Array {
  const bytes = new Uint8Array(512), encode = new TextEncoder();
  const put = (offset: number, count: number, value: string) => {
    const encoded = encode.encode(value);
    if (encoded.length > count) throw new Error("fixture header field too long");
    bytes.set(encoded, offset);
  };
  const last = path.lastIndexOf("/");
  const pathName = encode.encode(path).length <= 100 ? path : path.slice(last + 1);
  const prefix = pathName === path ? "" : path.slice(0, last);
  put(0, 100, pathName);
  put(100, 8, "0000664\0");
  put(108, 8, "0000000\0");
  put(116, 8, "0000000\0");
  put(124, 12, size.toString(8).padStart(11, "0") + "\0");
  put(136, 12, "00000000000\0");
  put(156, 1, type);
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  if (prefix) put(345, 155, prefix);
  bytes.fill(32, 148, 156);
  let sum = 0;
  for (const byte of bytes) sum += byte;
  put(148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return bytes;
}
function pack(entries: Entry[]): Uint8Array {
  const encoder = new TextEncoder(), parts: Uint8Array[] = [];
  for (const item of entries) {
    const data = typeof item.body === "string" ? encoder.encode(item.body) : item.body ?? new Uint8Array(0);
    parts.push(header(item.path, item.type ?? "0", data.length), data, new Uint8Array((512 - data.length % 512) % 512));
  }
  parts.push(new Uint8Array(1024));
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let position = 0;
  for (const part of parts) { result.set(part, position); position += part.length; }
  return result;
}
const fixtures = (files: Entry[] = [{ path: folder + "SKILL.md", body }]): Entry[] =>
  [{ path: "pax_global_header", type: "g", body: "24 comment=archive-test\n" },
    { path: root, type: "5" }, { path: root + "skills/", type: "5" },
    { path: root + "skills/link", type: "2" }, { path: folder, type: "5" }, ...files];
async function gzip(value: Uint8Array): Promise<Uint8Array> {
  const input = new ReadableStream<BufferSource>({
    start(controller) { controller.enqueue(new Uint8Array(value)); controller.close(); },
  });
  return new Uint8Array(await new Response(input.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

it("uses exactly one immutable codeload fetch for a 26-file subtree, despite unrelated symlinks", async () => {
  const files = [{ path: folder + "SKILL.md", body }, ...Array.from({ length: 25 }, (_, i) =>
    ({ path: folder + "scripts/file-" + i + ".py", body: "print('safe')\n" }))];
  const binary = await gzip(pack(fixtures(files)));
  const send = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    expect(String(url)).toBe("https://codeload.github.com/example/skills/tar.gz/" + source.commit);
    expect(options?.redirect).toBe("error");
    expect(options?.credentials).toBe("omit");
    expect(options?.signal).toBeTruthy();
    return new Response(binary, { status: 200 });
  });
  const result = await createGithubSkillSource(send as typeof fetch).read(source, AbortSignal.timeout(5000));
  expect(result.state).toBe("read");
  if (result.state !== "read") throw new Error("archive not read");
  expect(result.files).toHaveLength(26);
  expect(result.files.find(x => x.path === "SKILL.md")?.text).toBe(body);
  expect(send).toHaveBeenCalledOnce();
});

it("rejects selected symbolic links, case-colliding paths, binaries and oversized selected files", () => {
  const variants: Entry[][] = [
    [{ path: folder + "SKILL.md", body }, { path: folder + "evil", type: "2" }],
    [{ path: folder + "SKILL.md", body }, { path: folder + "skill.md", body }],
    [{ path: folder + "SKILL.md", body: new Uint8Array([0xff]) }],
    [{ path: folder + "SKILL.md", body }, { path: folder + "ref.md", body: "x".repeat(4_194_305) }],
  ];
  expect(variants.map(entries => readGithubTar(pack(fixtures(entries)), source).state))
    .toEqual(["invalid", "invalid", "invalid", "capacity"]);
});

it("rejects unsafe directory paths, malformed tar checksums, and incomplete archives without publishing partial content", () => {
  const invalidDirectory = pack(fixtures([{ path: folder + "../bad/", type: "5" }, { path: folder + "SKILL.md", body }]));
  expect(readGithubTar(invalidDirectory, source).state).toBe("invalid");
  const corrupted = pack(fixtures());
  corrupted[1500] = 255;
  expect(readGithubTar(corrupted, source).state).toBe("fallback");
  const complete = pack(fixtures());
  expect(readGithubTar(complete.subarray(0, complete.length - 513), source).state).toBe("fallback");
});

it("falls back to the existing bounded Git tree transport if archive fetch is unavailable", async () => {
  const tree = "b".repeat(40);
  const calls: string[] = [];
  const send = vi.fn(async (url: RequestInfo | URL) => {
    const value = String(url); calls.push(value);
    if (value.startsWith("https://codeload.github.com/")) return new Response(null, { status: 503 });
    if (value.endsWith("/git/commits/" + source.commit))
      return Response.json({ sha: source.commit, tree: { sha: tree } });
    if (value.endsWith("/git/trees/" + tree))
      return Response.json({ sha: tree, truncated: false, tree: [{ path: source.path, type: "tree", mode: "040000", sha: "c".repeat(40) }] });
    if (value.endsWith("/git/trees/" + "c".repeat(40) + "?recursive=1"))
      return Response.json({ sha: "c".repeat(40), truncated: false,
        tree: [{ path: "SKILL.md", type: "blob", mode: "100644", sha: "d".repeat(40), size: new TextEncoder().encode(body).length }] });
    if (value.endsWith("/SKILL.md")) return new Response(body);
    throw new Error("unexpected test URL");
  });
  const result = await createGithubSkillSource(send as typeof fetch).read(source, AbortSignal.timeout(5000));
  expect(result).toEqual({ state: "read", files: [{ path: "SKILL.md", text: body }] });
  expect(calls).toHaveLength(5);
});

it("aborts before any egress when a preview has already been cancelled", async () => {
  const send = vi.fn(async () => new Response("not used"));
  expect(await createGithubSkillSource(send as typeof fetch).read(source, AbortSignal.abort())).toEqual({ state: "unavailable" });
  expect(send).not.toHaveBeenCalled();
});

it("skips excessive Content-Length before decompression and preserves fallback semantics", async () => {
  const send = vi.fn(async () => new Response(new Uint8Array(0), {
    headers: { "content-length": String(8_388_609) },
  }));
  expect(await readGithubArchive(send as typeof fetch, source, AbortSignal.timeout(1000))).toEqual({ state: "fallback" });
});
