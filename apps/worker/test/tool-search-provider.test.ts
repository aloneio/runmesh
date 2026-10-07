import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { registerRemoteSearchTool } from "../src/mcp/providers/remote/search.js";
import type { ToolSearchEntry, ToolSearchResult } from "../src/contracts/tool-search.js";

const entry: ToolSearchEntry = { profile_id: "docs", profile_name: "Documents", profile_revision: 2, catalog_revision: 3,
  tool_id: `mcp.${"a".repeat(64)}`, version: "b".repeat(64), name: "search", description: "Find documentation" };
function fixture(result: ToolSearchResult = { state: "listed", tools: [entry] }) {
  let run: (query: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> = async () => { throw new Error("unregistered"); };
  const registerTool = vi.fn((_name: string, _config: unknown, handler: typeof run) => { run = handler; });
  const port = { search: vi.fn(async () => result) };
  registerRemoteSearchTool({ registerTool } as unknown as McpServer, port);
  return { port, registerTool, run: (query: unknown = { query: "search" }) => run(query) };
}
afterEach(() => vi.useRealTimers());

it("RM12 publishes a small search result with profile identity and strips transport extras", async () => {
  const f = fixture({ state: "listed", tools: [{ ...entry, token: "private" } as ToolSearchEntry] });
  expect(f.registerTool.mock.calls[0]?.[0]).toBe("remote_search");
  expect(JSON.parse((await f.run()).content[0]!.text)).toEqual({ state: "listed", tools: [entry] });
});

it.each(["denied", "invalid", "stale_catalog", "capacity", "unavailable"] as const)("RM12 reports %s as a non-dispatched search failure", async state => {
  const result = await fixture({ state }).run();
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]!.text).error.operation_state).toBe("not_started");
});

it("RM12 rejects invalid requests and malformed or over-limit responses", async () => {
  const f = fixture();
  expect((await f.run({ query: "测".repeat(86) })).isError).toBe(true);
  expect(f.port.search).not.toHaveBeenCalled();
  f.port.search.mockResolvedValueOnce({ state: "listed", tools: [entry, entry] });
  expect((await f.run()).isError).toBe(true);
  f.port.search.mockResolvedValueOnce({ state: "listed", tools: [entry] });
  expect((await f.run({ query: "search", limit: 1 })).isError).toBeUndefined();
  f.port.search.mockResolvedValueOnce({ state: "listed", tools: [{ ...entry, catalog_revision: 0 }] });
  expect((await f.run()).isError).toBe(true);
});

it("RM12 bounds a stalled search without replaying it", async () => {
  vi.useFakeTimers();
  const f = fixture(); f.port.search.mockImplementation(() => new Promise(() => undefined));
  const pending = f.run();
  await vi.advanceTimersByTimeAsync(7000);
  expect((await pending).isError).toBe(true);
  expect(f.port.search).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
