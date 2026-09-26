import { expect, it, vi } from "vitest";
import { createCatalogReader } from "../../apps/worker/src/application/capabilities/catalog-read.js";
import type { CatalogCursor, CatalogHead, CatalogReadPorts } from "../../apps/worker/src/contracts/catalog.js";
import type { IdentityDecision } from "../../apps/worker/src/contracts/identity.js";
import { catalogDefinition, catalogProfile, catalogSnapshot, fixtureDigest } from "./catalog-fixtures.js";

const principal = { client_id: "client-catalog", secret_version: 1 };
const identity = { schema_version: 2 as const, ...principal, label: "Test", native_scopes: [] };
async function fixture() {
  const snapshot = await catalogSnapshot("docs", [catalogDefinition("a"), catalogDefinition("b"), catalogDefinition("c")]);
  const head: CatalogHead = { schema_version: 1, profile_id: "docs", revision: 2, observed_digest: snapshot.digest, approved_digest: snapshot.digest, approved_names: ["a", "b", "c"] };
  let saved: CatalogCursor | undefined;
  const ports = {
    repository: { readHead: vi.fn(() => head), readSnapshot: vi.fn(() => snapshot), stage: vi.fn(), approve: vi.fn(), disable: vi.fn() },
    profile: vi.fn(() => catalogProfile()),
    identity: vi.fn(async (): Promise<IdentityDecision> => ({ state: "allowed", identity })), digest: vi.fn(fixtureDigest), now: vi.fn(() => 1000),
    cursor: { seal: vi.fn(async (cursor: CatalogCursor) => { saved = cursor; return "fixture-cursor"; }), open: vi.fn(async () => saved) },
  } satisfies CatalogReadPorts;
  return { ports, head, snapshot, run: (input: unknown = { profile_id: "docs" }, expired = () => false) => createCatalogReader(ports)(principal, input, new AbortController().signal, expired) };
}

it("W04 paginates all shared published tools without grant rows", async () => {
  const f = await fixture();
  const first = await f.run({ profile_id: "docs", limit: 1 });
  expect(first.state === "listed" && first.tools.map(tool => tool.definition.name)).toEqual(["a"]);
  expect(first.state === "listed" && first.next_cursor).toBe("fixture-cursor");
  const second = await f.run({ profile_id: "docs", cursor: "fixture-cursor" });
  expect(second.state === "listed" && second.tools.map(tool => tool.definition.name)).toEqual(["b"]);
  expect(second.state === "listed" && second.next_cursor).toBe("fixture-cursor");
  const third = await f.run({ profile_id: "docs", cursor: "fixture-cursor" });
  expect(third.state === "listed" && third.tools.map(tool => tool.definition.name)).toEqual(["c"]);
  expect(third.state === "listed" && third.next_cursor).toBeNull();
});

it("W04 revoked identities are not allowed to probe shared profiles", async () => {
  const f = await fixture(); f.ports.identity.mockResolvedValue({ state: "denied" });
  expect(await f.run()).toEqual({ state: "denied" });
  expect(f.ports.profile).not.toHaveBeenCalled(); expect(f.ports.repository.readSnapshot).not.toHaveBeenCalled();
  f.ports.identity.mockResolvedValue({ state: "allowed", identity });
  expect((await f.run()).state).toBe("listed");
  expect(f.ports.repository.readSnapshot).toHaveBeenCalledOnce();
  expect(f.ports.cursor.open).not.toHaveBeenCalled(); expect(f.ports.cursor.seal).not.toHaveBeenCalled();
});

it("W04 identity revoked while catalog data is hashed prevents disclosure", async () => {
  const f = await fixture();
  f.ports.identity.mockResolvedValueOnce({ state: "allowed", identity }).mockResolvedValueOnce({ state: "denied" });
  expect(await f.run()).toEqual({ state: "denied" });
});

it("W04 publications changed during signing invalidate the pending page", async () => {
  const f = await fixture();
  f.ports.cursor.seal.mockImplementation(async () => { f.ports.repository.readHead.mockReturnValue({ ...f.head, revision: 3 }); return "fixture-cursor"; });
  expect(await f.run({ profile_id: "docs", limit: 1 })).toEqual({ state: "stale_cursor" });
});

it("W04 expiry is bound to the first page and is not extended on subsequent reads", async () => {
  const f = await fixture(); await f.run({ profile_id: "docs", limit: 1 });
  f.ports.now.mockReturnValue(301001);
  expect(await f.run({ profile_id: "docs", cursor: "fixture-cursor" })).toEqual({ state: "stale_cursor" });
});

it("W04 schema/hash/deadline failures cannot turn into successful empty catalogs", async () => {
  const f = await fixture(); f.ports.digest.mockResolvedValue("a".repeat(64));
  expect(await f.run()).toEqual({ state: "unavailable" });
  f.ports.digest.mockImplementation(fixtureDigest);
  expect(await f.run({ profile_id: "docs" }, () => true)).toEqual({ state: "unavailable" });
  f.ports.repository.readHead.mockImplementation(() => { throw new Error("synthetic read failure"); });
  expect(await f.run()).toEqual({ state: "unavailable" });
});

it("W04 malformed final identities are rejected", async () => {
  const f = await fixture();
  f.ports.identity.mockResolvedValueOnce({ state: "allowed", identity }).mockResolvedValueOnce({ state: "malformed" });
  expect(await f.run()).toEqual({ state: "unavailable" });
});
