import { afterEach, expect, it, vi } from "vitest";
import type { CatalogHead, CatalogSnapshot } from "../../apps/worker/src/contracts/catalog.js";
import { catalogPublicName } from "../../apps/worker/src/contracts/catalog-values.js";
import type { ConnectionProfile } from "../../apps/worker/src/contracts/connectors.js";
import type { IdentityDecision } from "../../apps/worker/src/contracts/identity.js";
import { TOOL_SEARCH_LIMITS, parseToolSearchQuery, parseToolSearchResult, type ToolSearchEntry, type ToolSearchPorts } from "../../apps/worker/src/contracts/tool-search.js";
import { createToolSearcher } from "../../apps/worker/src/application/capabilities/search.js";
import { createToolSearchRanking, createToolSearchScorer, toolSearchDescription } from "../../apps/worker/src/domain/capabilities/tool-search.js";
import { catalogDefinition, catalogProfile, catalogSnapshot, fixtureDigest } from "./catalog-fixtures.js";

const principal = { client_id: "client-search", secret_version: 1 },
  identity = { schema_version: 2 as const, ...principal, label: "Search client", native_scopes: [] };
afterEach(() => vi.unstubAllGlobals());

async function fixture(ids = ["docs"]) {
  const profiles = new Map<string, ConnectionProfile>(), heads = new Map<string, CatalogHead>(), snapshots = new Map<string, CatalogSnapshot>();
  for (const id of ids) {
    const snapshot = await catalogSnapshot(id, [catalogDefinition("search_documents", "Search documents and 搜索文档"), catalogDefinition("deploy_workers", "Deploy edge workers 部署应用")]);
    profiles.set(id, { ...catalogProfile(id), display_name: `Connection ${id}` });
    heads.set(id, { schema_version: 1, profile_id: id, revision: 2, approved_digest: snapshot.digest,
      observed_digest: snapshot.digest, approved_names: snapshot.tools.map(tool => tool.definition.name) });
    snapshots.set(`${id}/${snapshot.digest}`, snapshot);
  }
  const ports = {
    profiles: vi.fn((after: string) => ({ profiles: [...profiles.values()].filter(profile => profile.profile_id > after).sort((a, b) => a.profile_id < b.profile_id ? -1 : 1), next_after: null })),
    repository: { readHead: vi.fn((id: string) => heads.get(id)), readSnapshot: vi.fn((id: string, digest: string) => snapshots.get(`${id}/${digest}`)) },
    identity: vi.fn(async (): Promise<IdentityDecision> => ({ state: "allowed", identity })), digest: vi.fn(fixtureDigest),
  } satisfies ToolSearchPorts;
  return { ports, profiles, heads, snapshots,
    run: (query: unknown = { query: "search" }, signal = new AbortController().signal, expired = () => false) => createToolSearcher(ports)(principal, query, signal, expired) };
}

it("RM12 ranks names before descriptions and matches English and Chinese keywords", () => {
  const score = (query: string, name: string, description = "") => createToolSearchScorer(query)({ name, description, profile_name: "Cloudflare" });
  expect(score("Search", "search")).toBeGreaterThan(score("search", "search_documents"));
  expect(score("search", "search_documents")).toBeGreaterThan(score("search", "documents", "Search documents"));
  expect(score("ＣＬＯＵＤＦＬＡＲＥ 搜索", "search", "搜索文档")).toBeGreaterThan(0);
  expect(score("部署", "deploy", "部署应用")).toBeGreaterThan(0);
  expect(score("workers missing", "workers", "Deploy workers")).toBe(0);
});

it("RM12 produces deterministic bounded metadata and valid Unicode summaries", () => {
  const entries: ToolSearchEntry[] = Array.from({ length: 50 }, (_, index) => ({ profile_id: `profile-${String(index).padStart(3, "0")}`,
    profile_name: "Documents", profile_revision: 2, catalog_revision: 2, tool_id: `mcp.${"a".repeat(64)}`, version: "b".repeat(64), name: "search", description: "Search" }));
  const first = createToolSearchRanking(5), second = createToolSearchRanking(5);
  for (const entry of entries) first.offer(10, entry);
  for (const entry of [...entries].reverse()) second.offer(10, entry);
  expect(first.results()).toEqual(second.results());
  expect(first.results()).toHaveLength(5);
  expect(toolSearchDescription("a".repeat(510) + "🚀" + "b".repeat(10))).toBe("a".repeat(510) + "…");
});

it("RM12 validates keyword, result and response metadata bounds", () => {
  for (const value of [{ query: "" }, { query: "---" }, { query: "测".repeat(86) }, { query: "x", limit: 21 }, { query: "x", limit: 0 }, { query: "x", profile_id: "../private" }, { query: "x", extra: true }])
    expect(parseToolSearchQuery(value)).toBeUndefined();
  expect(parseToolSearchQuery({ query: "  搜索 docs  ", limit: 20 })).toEqual({ query: "搜索 docs", limit: 20 });
  expect(parseToolSearchResult({ state: "listed", tools: new Array(21).fill({}) })).toBeUndefined();
});

it("RM12 searches beyond direct-directory limits without upstream access or writes", async () => {
  const f = await fixture(Array.from({ length: 18 }, (_, index) => `profile-${String(index).padStart(2, "0")}`)), network = vi.fn(() => { throw new Error("unexpected network"); });
  vi.stubGlobal("fetch", network); vi.stubGlobal("WebSocket", network);
  const result = await f.run({ query: "documents", limit: 20 });
  expect(result.state).toBe("listed");
  if (result.state !== "listed") throw new Error(result.state);
  expect(result.tools).toHaveLength(18);
  expect(new Set(result.tools.map(tool => tool.tool_id)).size).toBe(18);
  expect(new Set(result.tools.map(tool => tool.profile_id)).size).toBe(18);
  expect(result.tools.every(tool => !("definition" in tool) && !("inputSchema" in tool))).toBe(true);
  expect(f.ports.repository.readSnapshot).toHaveBeenCalledTimes(18);
  expect(f.ports.digest).toHaveBeenCalledTimes(18);
  expect(network).not.toHaveBeenCalled();
  expect(parseToolSearchResult({ ...result, [Symbol.dispose]: () => undefined })).toEqual(result);
});

it("RM12 filters paused profiles, unpublished tools and an optional connection", async () => {
  const f = await fixture(["alpha", "beta", "gamma"]);
  f.profiles.set("alpha", { ...f.profiles.get("alpha")!, enabled: false });
  f.heads.set("beta", { ...f.heads.get("beta")!, approved_digest: null, approved_names: [] });
  const result = await f.run();
  expect(result.state === "listed" && result.tools.map(tool => tool.profile_id)).toEqual(["gamma"]);
  expect(await f.run({ query: "search", profile_id: "alpha" })).toEqual({ state: "listed", tools: [] });
  expect(await f.run({ query: "search", profile_id: "missing" })).toEqual({ state: "listed", tools: [] });
  expect(f.ports.repository.readSnapshot.mock.calls.every(([id]) => id === "gamma")).toBe(true);
});

it("RM12 excludes removed and changed tool versions until the current version is published", async () => {
  const f = await fixture(), next = await catalogSnapshot("docs", [catalogDefinition("search_documents", "Updated search documentation")]);
  f.snapshots.set(`docs/${next.digest}`, next);
  f.heads.set("docs", { ...f.heads.get("docs")!, observed_digest: next.digest });
  expect(await f.run()).toEqual({ state: "listed", tools: [] });
  f.heads.set("docs", { ...f.heads.get("docs")!, approved_digest: next.digest, approved_names: ["search_documents"], revision: 3 });
  const result = await f.run();
  expect(result.state === "listed" && result.tools[0]?.version).toBe(next.tools[0]?.version);
});

it("RM12 rejects revoked or changed identities before reads and before disclosure", async () => {
  const f = await fixture();
  f.ports.identity.mockResolvedValueOnce({ state: "denied" });
  expect(await f.run()).toEqual({ state: "denied" });
  expect(f.ports.profiles).not.toHaveBeenCalled();
  f.ports.identity.mockResolvedValueOnce({ state: "allowed", identity }).mockResolvedValueOnce({ state: "allowed", identity: { ...identity, secret_version: 2 } });
  expect(await f.run()).toEqual({ state: "denied" });
  f.ports.identity.mockResolvedValueOnce({ state: "allowed", identity }).mockResolvedValueOnce({ state: "malformed" });
  expect(await f.run()).toEqual({ state: "unavailable" });
});

it("RM12 fences catalog and profile changes during asynchronous verification", async () => {
  const f = await fixture();
  f.ports.digest.mockImplementationOnce(async value => { f.heads.set("docs", { ...f.heads.get("docs")!, revision: 3 }); return fixtureDigest(value); });
  expect(await f.run()).toEqual({ state: "stale_catalog" });
  f.ports.digest.mockImplementationOnce(async value => { f.profiles.set("docs", { ...f.profiles.get("docs")!, enabled: false }); return fixtureDigest(value); });
  expect(await f.run()).toEqual({ state: "stale_catalog" });
});

it("RM12 fails on damaged snapshots, malformed pages and expired reads", async () => {
  const f = await fixture();
  f.ports.digest.mockResolvedValueOnce("0".repeat(64));
  expect(await f.run()).toEqual({ state: "unavailable" });
  expect(await f.run({ query: "search" }, AbortSignal.abort())).toEqual({ state: "unavailable" });
  expect(await f.run({ query: "search" }, new AbortController().signal, () => true)).toEqual({ state: "unavailable" });
  f.ports.profiles.mockReturnValueOnce({ profiles: [catalogProfile(), catalogProfile()], next_after: null });
  expect(await f.run()).toEqual({ state: "unavailable" });
});

it("RM12 bounds the total verified bytes and returns capacity without partial results", async () => {
  const f = await fixture([]), hash = "a".repeat(64), definitions = Array.from({ length: 48 }, (_, index) => catalogDefinition(`search_${String(index).padStart(3, "0")}`, "x".repeat(8192)));
  for (let index = 0; index < 44; index++) {
    const id = `profile-${String(index).padStart(2, "0")}`, profile = catalogProfile(id), tools = definitions.map((definition, toolIndex) => {
      const digest = toolIndex.toString(16).padStart(64, "0");
      return { definition, tool_id: `mcp.${digest}`, version: hash, public_name: catalogPublicName(id, definition.name, digest) };
    });
    f.profiles.set(id, profile);
    f.heads.set(id, { schema_version: 1, profile_id: id, revision: 2, observed_digest: hash, approved_digest: hash, approved_names: definitions.map(tool => tool.name) });
    f.snapshots.set(`${id}/${hash}`, { schema_version: 1, profile_id: id, connector_id: profile.connector_id, endpoint: profile.endpoint, digest: hash, tools });
  }
  f.ports.digest.mockResolvedValue(hash);
  expect(await f.run()).toEqual({ state: "capacity" });
  expect(f.ports.repository.readSnapshot.mock.calls.length).toBeLessThan(44);
  expect(f.ports.digest.mock.calls.reduce((sum, [body]) => sum + new TextEncoder().encode(body).byteLength, 0)).toBeLessThanOrEqual(TOOL_SEARCH_LIMITS.scan_bytes);
}, 30_000);
