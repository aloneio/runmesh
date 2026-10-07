import { expect, it, vi } from "vitest";
import { createGithubSkillSource } from "../src/platform/skills/github-source.js";
import { SKILL_SOURCE_LIMITS } from "../src/contracts/skill-source.js";
import { SKILL_LIMITS } from "../src/contracts/skills.js";

const source = { repository: "https://github.com/example/skills", commit: "a".repeat(40), path: "" }, rootSha = "b".repeat(40),
  body = "---\nname: research\ndescription: Research documentation\n---\nRead references.\n";
const api = "https://api.github.com/repos/example/skills", raw = `https://raw.githubusercontent.com/example/skills/${source.commit}/`;
const blob = (path = "SKILL.md", size = new TextEncoder().encode(body).byteLength) => ({ path, mode: "100644", type: "blob", sha: "c".repeat(40), size });
function fixture(entries: readonly Record<string, unknown>[] = [blob()]) {
  const responses = new Map<string, () => Response>([
    [`${api}/git/commits/${source.commit}`, () => Response.json({ sha: source.commit, tree: { sha: rootSha } })],
    [`${api}/git/trees/${rootSha}?recursive=1`, () => Response.json({ sha: rootSha, truncated: false, tree: entries })],
    [raw + "SKILL.md", () => new Response(body)],
  ]);
  const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false); expect(headers.has("cookie")).toBe(false);
    const response = responses.get(String(input));
    if (!response) throw new Error("unexpected test URL: " + String(input));
    return response();
  });
  return { send, responses, run: (input = source, signal = new AbortController().signal) => createGithubSkillSource(send as typeof fetch).read(input, signal) };
}

it("RM07 fetches a fixed commit from fixed hosts and retains text bytes", async () => {
  const f = fixture();
  expect(await f.run()).toEqual({ state: "read", files: [{ path: "SKILL.md", text: body }] });
  expect(f.send.mock.calls.map(([url]) => String(url))).toEqual([`${api}/git/commits/${source.commit}`, `${api}/git/trees/${rootSha}?recursive=1`, raw + "SKILL.md"]);
});

it("RM07 resolves a chosen subtree even when unrelated root files use other names", async () => {
  const f = fixture(), child = "d".repeat(40);
  f.responses.set(`${api}/git/trees/${rootSha}`, () => Response.json({ sha: rootSha, truncated: false,
    tree: [blob("参考 notes.md"), { path: "research", type: "tree", mode: "040000", sha: child }] }));
  f.responses.set(`${api}/git/trees/${child}?recursive=1`, () => Response.json({ sha: child, truncated: false, tree: [blob()] }));
  f.responses.set(raw + "research/SKILL.md", () => new Response(body));
  expect(await f.run({ ...source, path: "research" })).toEqual({ state: "read", files: [{ path: "SKILL.md", text: body }] });
});

it.each([301, 302, 307, 308, 403, 429, 500])("RM07 rejects HTTP %s without following redirects or retrying", async status => {
  const f = fixture();
  f.responses.set(`${api}/git/commits/${source.commit}`, () => new Response("upstream response", { status, headers: { location: "https://elsewhere.example/private" } }));
  expect(await f.run()).toEqual({ state: "unavailable" });
  expect(f.send).toHaveBeenCalledOnce();
});

it("RM07 rejects missing sources, truncated trees and metadata above the limit", async () => {
  const missing = fixture(); missing.responses.set(`${api}/git/commits/${source.commit}`, () => new Response("missing", { status: 404 }));
  expect(await missing.run()).toEqual({ state: "missing" });
  const truncated = fixture(); truncated.responses.set(`${api}/git/trees/${rootSha}?recursive=1`, () => Response.json({ sha: rootSha, truncated: true, tree: [blob()] }));
  expect(await truncated.run()).toEqual({ state: "capacity" });
  expect(truncated.send).toHaveBeenCalledTimes(2);
  const excessive = fixture(); excessive.responses.set(`${api}/git/commits/${source.commit}`, () => new Response("x", { headers: { "content-length": String(SKILL_SOURCE_LIMITS.metadata_bytes + 1) } }));
  expect(await excessive.run()).toEqual({ state: "capacity" });
});

it.each([
  { ...blob(), path: "../SKILL.md" }, { ...blob(), path: "a//SKILL.md" },
  { ...blob(), mode: "120000" }, { ...blob(), mode: "160000", type: "commit" },
  { ...blob(), size: -1 }, { ...blob(), size: 1.5 },
])("RM07 rejects invalid selected entries %j before file downloads", async entry => {
  const f = fixture([entry]);
  expect(await f.run()).toEqual({ state: "invalid" });
  expect(f.send).toHaveBeenCalledTimes(2);
});

it("RM07 rejects case collisions and paths exceeding the source depth before fetching", async () => {
  const f = fixture([blob(), blob("skill.md")]);
  expect(await f.run()).toEqual({ state: "invalid" });
  expect(f.send).toHaveBeenCalledTimes(2);
  const invalid = fixture();
  expect(await invalid.run({ ...source, path: "a/".repeat(8) + "b" })).toEqual({ state: "invalid" });
  expect(invalid.send).not.toHaveBeenCalled();
});

it.each([
  new TextEncoder().encode("version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 12\n"),
  new Uint8Array([0xff, 0xfe, 0xfd]), new Uint8Array([65, 0, 66]),
])("RM07 rejects LFS pointers and binary content", async content => {
  const f = fixture([blob("SKILL.md", content.byteLength)]);
  f.responses.set(raw + "SKILL.md", () => new Response(content));
  expect(await f.run()).toEqual({ state: "invalid" });
});

it("RM07 admits 32 files and rejects a 33rd before file downloads", async () => {
  const entries = Array.from({ length: SKILL_SOURCE_LIMITS.files }, (_, index) => blob(index === 0 ? "SKILL.md" : `ref-${index}.md`)), f = fixture(entries);
  for (const entry of entries) f.responses.set(raw + entry.path, () => new Response(body));
  const result = await f.run();
  expect(result.state === "read" && result.files.length).toBe(32);
  expect(f.send).toHaveBeenCalledTimes(34);
  const excess = fixture([...entries, blob("extra.md")]);
  expect(await excess.run()).toEqual({ state: "capacity" });
  expect(excess.send).toHaveBeenCalledTimes(2);
});

it("RM07 bounds declared file bytes and aggregate bytes before file downloads", async () => {
  const file = fixture([blob("SKILL.md", SKILL_LIMITS.file_bytes + 1)]);
  expect(await file.run()).toEqual({ state: "capacity" });
  expect(file.send).toHaveBeenCalledTimes(2);
  const aggregate = fixture(Array.from({ length: 9 }, (_, index) => blob(`file-${index}.md`, SKILL_LIMITS.file_bytes)));
  expect(await aggregate.run()).toEqual({ state: "capacity" });
  expect(aggregate.send).toHaveBeenCalledTimes(2);
});

it("RM07 checks actual stream bytes even when content length is absent or misleading", async () => {
  const f = fixture(); f.responses.set(raw + "SKILL.md", () => new Response(new Uint8Array(SKILL_LIMITS.file_bytes + 1)));
  expect(await f.run()).toEqual({ state: "capacity" });
  const mismatch = fixture(); mismatch.responses.set(raw + "SKILL.md", () => new Response(body + "more"));
  expect(await mismatch.run()).toEqual({ state: "invalid" });
});

it("RM07 cancellation stops a pending body and prevents subsequent requests", async () => {
  const before = fixture();
  expect(await before.run(source, AbortSignal.abort())).toEqual({ state: "unavailable" });
  expect(before.send).not.toHaveBeenCalled();
  const f = fixture(), controller = new AbortController(), canceled = vi.fn();
  f.responses.set(raw + "SKILL.md", () => new Response(new ReadableStream<Uint8Array>({
    pull() { controller.abort(); }, cancel: canceled,
  })));
  expect(await f.run(source, controller.signal)).toEqual({ state: "unavailable" });
  expect(canceled).toHaveBeenCalledOnce();
  expect(f.send).toHaveBeenCalledTimes(3);
});
