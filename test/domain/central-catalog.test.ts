import { expect, it, vi } from "vitest";
import { catalogJson } from "../../apps/worker/src/contracts/catalog-json.js";
import { catalogSchemaGraph } from "../../apps/worker/src/contracts/catalog-schema.js";
import { parseCatalogCommand, parseRemoteTool, parseCatalogSnapshot } from "../../apps/worker/src/contracts/catalog-values.js";
import { catalogChanges, compatibleApprovedTools, verifiedCatalogSnapshot } from "../../apps/worker/src/domain/capabilities/catalog.js";
import { createCatalogManager } from "../../apps/worker/src/application/capabilities/catalog-admin.js";
import { catalogDefinition, catalogProfile, catalogSnapshot, fixtureDigest } from "./catalog-fixtures.js";

it("W04 canonical JSON is deterministic, bounded and does not evaluate getters", () => {
  expect(catalogJson({ b: 1, a: [false, null, "文"] }, 100)).toBe(catalogJson({ a: [false, null, "文"], b: 1 }, 100));
  const getter = vi.fn(); const object = Object.defineProperty({}, "value", { enumerable: true, get: getter });
  expect(catalogJson(object, 100)).toBeUndefined(); expect(getter).not.toHaveBeenCalled();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [cycle, undefined, new Date(), NaN, Infinity, BigInt(1), { a: () => 1 }, "文".repeat(10)]) expect(catalogJson(value, 20)).toBeUndefined();
  expect(catalogJson({ toJSON: () => "execute" }, 100)).toBeUndefined();
});

it("W04 same-name tools on different profiles have stable collision-resistant names", async () => {
  const a = await catalogSnapshot("docs:a"), b = await catalogSnapshot("docs_a");
  expect(a.tools[0]!.tool_id).not.toBe(b.tools[0]!.tool_id);
  expect(a.tools[0]!.public_name).not.toBe(b.tools[0]!.public_name);
  expect(a.tools[0]!.public_name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/u);
  const changed = await catalogSnapshot("docs:a", [catalogDefinition("search", "New behavior")]);
  expect(changed.tools[0]!.public_name).toBe(a.tools[0]!.public_name);
  expect(changed.tools[0]!.version).not.toBe(a.tools[0]!.version);
  expect(changed.digest).not.toBe(a.digest);
});

it("W04 property ordering and upstream list ordering do not change snapshot identity", async () => {
  const a = catalogDefinition("a"), b = catalogDefinition("b");
  const reordered = { inputSchema: a.inputSchema, description: a.description, name: a.name };
  expect((await catalogSnapshot("docs", [a, b])).digest).toBe((await catalogSnapshot("docs", [b, reordered])).digest);
});

it.each([
  { inputSchema: null }, { inputSchema: { type: "string" } }, { inputSchema: { type: "object", required: ["a", "a"] } },
  { inputSchema: { type: "object", $schema: "http://json-schema.org/draft-07/schema#" } },
  { inputSchema: { type: "object", properties: { a: { type: "string", pattern: "(a+)+$" } } } },
  { inputSchema: { type: "object", properties: { a: { type: "string", format: "uri" } } } },
  { inputSchema: { type: "object", $ref: "https://private.invalid/schema" } },
  { inputSchema: { type: "object", $ref: "file:///secret" } },
  { inputSchema: { type: "object", $dynamicRef: "#a" } },
  { inputSchema: { type: "object", properties: { a: { type: "string", "x-mcp-header": "Authorization" } } } },
  { name: "bad tool" }, { annotations: { readOnlyHint: "true" } }, { _meta: { grant: "admin" } },
  { description: "a".repeat(8193) }, { inputSchema: { type: "object", anyOf: [] } },
])("W04 unsupported/invalid tool contracts are rejected without partial publication: %j", change => {
  expect(parseRemoteTool({ ...catalogDefinition(), ...change })).toBeUndefined();
});

it("W04 supports bounded local refs without confusing property names or JSON data with keywords", () => {
  const value = { ...catalogDefinition(), inputSchema: { type: "object", $defs: { value: { type: "string" } },
    properties: { pattern: { $ref: "#/$defs/value" }, $ref: { type: "string", default: "https://not-a-schema.invalid" } },
    examples: [{ pattern: "not executed", $ref: "https://data.invalid" }] } };
  expect(parseRemoteTool(value)).toEqual(value);
  expect(parseRemoteTool({ ...value, inputSchema: { type: "object", $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } } } })).toBeUndefined();
  expect(parseRemoteTool({ ...value, inputSchema: { type: "object", $ref: "#/$defs/missing" } })).toBeUndefined();
});

it("W04 enforces aggregate/count/depth budgets and accepts a genuine empty catalog", async () => {
  const stage = (tools: unknown) => parseCatalogCommand({ action: "stage", profile_id: "docs", expected_revision: 0, tools });
  expect(stage(Array.from({ length: 129 }, (_, i) => catalogDefinition(`tool${i}`)))).toBeUndefined();
  expect(stage([catalogDefinition(), catalogDefinition()])).toBeUndefined();
  expect(stage(Array.from({ length: 70 }, (_, i) => catalogDefinition(`tool${i}`, "文".repeat(3000))))).toBeUndefined();
  let schema: unknown = { type: "string" };
  for (let i = 0; i < 30; i++) schema = { type: "object", properties: { next: schema } };
  expect(parseRemoteTool({ ...catalogDefinition(), inputSchema: schema })).toBeUndefined();
  expect((await catalogSnapshot("docs", [])).tools).toEqual([]);
});

it.each(["$defs", "definitions"])("W04 schema graph preserves indexed and escaped %s references without treating data as schemas", definitions => {
  const schema = { type: "object", [definitions]: { "a/b~c value": { anyOf: [false, { type: "integer" }] } },
    properties: { value: { $ref: "#/" + definitions + "/a~1b~0c%20value/anyOf/1" } },
    default: { $ref: "https://data.invalid" }, examples: [{ allOf: ["data"] }] };
  expect(parseRemoteTool({ name: "count", inputSchema: schema })).toBeDefined();
  const graph = catalogSchemaGraph(schema, true)!;
  expect(graph.get("/properties/value")).toEqual(["/" + definitions + "/a~1b~0c value/anyOf/1"]);
  expect(graph.get("/" + definitions + "/a~1b~0c value/anyOf/0")).toEqual([]);
  expect([...graph.keys()].some(path => path.startsWith("/default") || path.startsWith("/examples"))).toBe(false);
});

it("W04 schema analysis retains a bounded graph instead of expanding repeated references", () => {
  const definitions: Record<string, object> = { layer0: { type: "integer" } };
  for (let i = 1; i <= 20; i++) {
    const ref = { $ref: "#/$defs/layer" + (i - 1) };
    definitions["layer" + i] = { allOf: [ref, ref] };
  }
  const graph = catalogSchemaGraph({ type: "object", $defs: definitions, properties: { value: { $ref: "#/$defs/layer20" } } }, true)!;
  expect(graph.size).toBe(63);
  for (const index of [0, 1]) expect(graph.get("/$defs/layer20/allOf/" + index)).toEqual(["/$defs/layer19"]);
});

it("W04 metadata/risk/schema changes stay quarantined until explicit reapproval", async () => {
  const old = await catalogSnapshot("docs", [catalogDefinition("a"), catalogDefinition("b"), catalogDefinition("removed")]);
  const current = await catalogSnapshot("docs", [catalogDefinition("a"), { ...catalogDefinition("b"), annotations: { readOnlyHint: false } }, catalogDefinition("new")]);
  expect(compatibleApprovedTools(current, old, ["a", "b", "removed"]).map(tool => tool.definition.name)).toEqual(["a"]);
  expect(catalogChanges(current, old)).toEqual([{ name: "a", state: "unchanged" }, { name: "b", state: "changed" }, { name: "new", state: "added" }, { name: "removed", state: "removed" }]);
});

it("W04 snapshot hash and profile binding reject plausible but altered storage", async () => {
  const original = await catalogSnapshot();
  expect(await verifiedCatalogSnapshot(original, catalogProfile(), original.digest, fixtureDigest)).toBe(true);
  const bad = structuredClone(original); (bad.tools[0]!.definition as { description: string }).description = "changed";
  expect(parseCatalogSnapshot(bad)).toBeDefined();
  expect(await verifiedCatalogSnapshot(bad, catalogProfile(), original.digest, fixtureDigest)).toBe(false);
  expect(await verifiedCatalogSnapshot(original, catalogProfile("other"), original.digest, fixtureDigest)).toBe(false);
});

it("W04 revocation and profile mutation during hashing prevent catalog writes", async () => {
  const stage = vi.fn(), profile = vi.fn(() => catalogProfile());
  const authorize = vi.fn(async (): Promise<"allowed" | "denied"> => "allowed");
  const ports = { profile, authorize, digest: fixtureDigest,
    repository: { readHead: () => undefined, readSnapshot: () => undefined, stage, approve: vi.fn(), disable: vi.fn() } };
  const manager = createCatalogManager(ports), command = { action: "stage", profile_id: "docs", expected_revision: 0, tools: [catalogDefinition()] };
  authorize.mockResolvedValueOnce("allowed").mockResolvedValueOnce("denied");
  expect(await manager.mutate(command, new AbortController().signal, () => false)).toEqual({ state: "denied" });
  expect(stage).not.toHaveBeenCalled();
  authorize.mockResolvedValue("allowed"); profile.mockReturnValueOnce(catalogProfile()).mockReturnValueOnce({ ...catalogProfile(), revision: 3 });
  expect(await manager.mutate(command, new AbortController().signal, () => false)).toEqual({ state: "stale_profile" });
  expect(stage).not.toHaveBeenCalled();
});
