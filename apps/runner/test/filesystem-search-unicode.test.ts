import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { PathPolicy } from "../src/path-policy.js";

async function fixture(value: string, mode: "literal" | "filename") {
  const base = await mkdtemp(join(tmpdir(), "runmesh-search-unicode-")), root = join(base, "workspace");
  await mkdir(root);
  const path = mode === "filename" ? `${value}.txt` : "source.txt";
  await writeFile(join(root, path), mode === "filename" ? "unrelated content" : value);
  const service = new FilesystemService(new PathPolicy([{ workspaceId: "test", rootPath: root, readonly: true, shell: false }]));
  return { path,
    search: (query: string, case_sensitive = false) => service.search({ workspace_id: "test", query, mode, case_sensitive }),
    cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

const examples = [
  { name: "expansion before match", value: "İABC", query: "abc", column: 2, match: "ABC" },
  { name: "surrogate pair before expansion", value: "😀İABC", query: "abc", column: 3, match: "ABC" },
  { name: "combining character before expansion", value: "e\u0301İABC", query: "abc", column: 4, match: "ABC" },
  { name: "expanded query", value: "xi\u0307y", query: "İ", column: 2, match: "i\u0307" },
  { name: "expanded source", value: "xİy", query: "i\u0307", column: 2, match: "İ" },
  { name: "match inside expanded source", value: "xİy", query: "\u0307", column: 2, match: "İ" },
  { name: "full-string contextual lowercase", value: "ΟΣ!", query: "ος", column: 1, match: "ΟΣ" },
] as const;

for (const mode of ["literal", "filename"] as const) {
  it.each(examples)(`${mode} maps $name to the original text`, async example => {
    const f = await fixture(example.value, mode);
    try {
      expect(await f.search(example.query)).toMatchObject({ truncated: false,
        results: [{ path: f.path, line: 1, column: example.column, match: example.match }],
      });
    } finally { await f.cleanup(); }
  });

  it(`${mode} keeps case-sensitive matching and original Unicode columns`, async () => {
    const f = await fixture("😀İABC", mode);
    try {
      expect(await f.search("abc", true)).toMatchObject({ results: [] });
      expect(await f.search("ABC", true)).toMatchObject({ results: [{ column: 3, match: "ABC" }] });
      expect(await f.search("İ", true)).toMatchObject({ results: [{ column: 2, match: "İ" }] });
      expect(await f.search("i\u0307", true)).toMatchObject({ results: [] });
    } finally { await f.cleanup(); }
  });
}

it("keeps case-insensitive queries literal when they contain regular expression punctuation", async () => {
  const f = await fixture("İA+B.[X]", "literal");
  try {
    expect(await f.search("a+b.[x]")).toMatchObject({ results: [{ column: 2, match: "A+B.[X]" }] });
    expect(await f.search("a+b.*[x]")).toMatchObject({ results: [] });
  } finally { await f.cleanup(); }
});

it("maps an expanded bounded line in one pass", async () => {
  const f = await fixture("İ".repeat(120_000) + "ABC", "literal");
  try {
    expect(await f.search("abc")).toMatchObject({ truncated: false, results: [{ column: 120_001, match: "ABC" }] });
  } finally { await f.cleanup(); }
});

it("preserves literal UTF-16 query boundaries beside an unrelated expanded character", async () => {
  const f = await fixture("😀İ", "literal");
  try {
    for (const [query, column] of [["\ud83d", 1], ["\ude00", 2]] as const) {
      for (const caseSensitive of [false, true]) {
        expect(await f.search(query, caseSensitive)).toMatchObject({ results: [{ column, match: query }] });
      }
    }
  } finally { await f.cleanup(); }
});
