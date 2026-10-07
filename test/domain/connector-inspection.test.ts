import { expect, it, vi } from "vitest";
import { createConnectorInspection } from "../../apps/worker/src/application/connectors/inspection.js";
import type { ConnectorInspectionPorts } from "../../apps/worker/src/contracts/connector-inspection.js";
import type { AdminDecision } from "../../apps/worker/src/contracts/admin-session.js";
import { MCP_REGISTRY_LIMITS } from "../../apps/worker/src/contracts/mcp-registry.js";
import { RemoteFault, type RemoteResult, type RemoteSession } from "../../apps/worker/src/contracts/remote.js";
import type { RemoteServerInfo } from "../../apps/worker/src/contracts/remote-server.js";
import { previewRegistryEntry } from "../../apps/worker/src/domain/connectors/registry-entry.js";
import { catalogDefinition, catalogProfile } from "./catalog-fixtures.js";

function inspection(tools = true) {
  const server: RemoteServerInfo = { protocol_version: "2026-07-28", capabilities: { tools, resources: true, prompts: true, tasks: false, apps: false } };
  const session = { describe: vi.fn(() => server), current: vi.fn(() => true), listTools: vi.fn(async () => [catalogDefinition()]),
    callTool: vi.fn(async (): Promise<RemoteResult> => { throw new Error("business call forbidden"); }), close: vi.fn(async () => undefined) } satisfies RemoteSession;
  const ports = { connector: { open: vi.fn(async () => session), validate: vi.fn(() => true) },
    authorize: vi.fn(async (): Promise<AdminDecision> => "allowed"), now: vi.fn(() => 1_000) } satisfies ConnectorInspectionPorts;
  return { ports, session, server, run: (signal = new AbortController().signal) => createConnectorInspection(ports)(catalogProfile(), signal) };
}

it("RM10 observes protocol, capabilities and tools without publication or a business call", async () => {
  const f = inspection();
  expect(await f.run()).toEqual({ state: "inspected", endpoint: catalogProfile().endpoint, server: f.server, tools_count: 1, observed_at_ms: 1_000 });
  expect(f.session.listTools).toHaveBeenCalledOnce();
  expect(f.session.callTool).not.toHaveBeenCalled();
  expect(f.session.close).toHaveBeenCalledOnce();
  expect(f.ports.authorize).toHaveBeenCalledTimes(2);
  expect(f.ports.connector.validate).not.toHaveBeenCalled();
});

it("RM10 inspects a resource-only server without asking it to list tools", async () => {
  const f = inspection(false);
  expect(await f.run()).toMatchObject({ state: "inspected", tools_count: null, server: { capabilities: { tools: false, resources: true } } });
  expect(f.session.listTools).not.toHaveBeenCalled();
  expect(f.session.callTool).not.toHaveBeenCalled();
  expect(f.session.close).toHaveBeenCalledOnce();
});

it("RM10 requires an administrator before opening the upstream connection", async () => {
  const f = inspection(); f.ports.authorize.mockResolvedValueOnce("denied");
  expect(await f.run()).toEqual({ state: "denied", code: "permission_denied" });
  expect(f.ports.connector.open).not.toHaveBeenCalled();
});

it("RM10 reports upstream authorization requirements without retrying or publishing", async () => {
  const f = inspection(); f.ports.connector.open.mockRejectedValueOnce(new RemoteFault("authorization_required"));
  expect(await f.run()).toEqual({ state: "authorization_required", code: "authorization_required" });
  expect(f.ports.connector.open).toHaveBeenCalledOnce();
  expect(f.session.callTool).not.toHaveBeenCalled();
});

it("RM10 closes the session before rejecting a revoked administrator", async () => {
  const f = inspection(); f.ports.authorize.mockResolvedValueOnce("allowed").mockImplementationOnce(async () => {
    expect(f.session.close).toHaveBeenCalledOnce(); return "denied";
  });
  expect(await f.run()).toEqual({ state: "denied", code: "permission_denied" });
  expect(f.session.close).toHaveBeenCalledOnce();
});

it.each(["list", "close"])("RM10 withholds results when credentials change during %s", async stage => {
  const f = inspection();
  if (stage === "list") f.session.listTools.mockImplementationOnce(async () => { f.session.current.mockReturnValue(false); return [catalogDefinition()]; });
  else f.session.close.mockImplementationOnce(async () => { f.session.current.mockReturnValue(false); });
  expect(await f.run()).toEqual({ state: "unavailable", code: "result_withheld" });
  expect(f.session.close).toHaveBeenCalledOnce();
});

it("RM10 closes failed discovery and canceled sessions without issuing business calls", async () => {
  const f = inspection(); f.session.listTools.mockRejectedValueOnce(new RemoteFault("upstream_protocol_error"));
  expect(await f.run()).toEqual({ state: "unavailable", code: "upstream_protocol_error" });
  expect(f.session.close).toHaveBeenCalledOnce();
  expect(f.session.callTool).not.toHaveBeenCalled();
  const canceled = inspection();
  expect(await canceled.run(AbortSignal.abort())).toEqual({ state: "unavailable", code: "operation_timed_out" });
  expect(canceled.ports.connector.open).not.toHaveBeenCalled();
});

it("RM10 rejects any connector attempt to dispatch a business operation", async () => {
  const f = inspection(), open: ConnectorInspectionPorts["connector"]["open"] = async (_profile, _signal, dispatched) => { dispatched(); return f.session; };
  const ports: ConnectorInspectionPorts = { ...f.ports, connector: { ...f.ports.connector, open } };
  expect(await createConnectorInspection(ports)(catalogProfile(), new AbortController().signal)).toEqual({ state: "unavailable", code: "unsupported_interaction" });
  expect(f.session.callTool).not.toHaveBeenCalled();
});

const registryEntry = () => ({ $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.example/docs", version: "1.2.3", description: "Documentation tools", remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }] });

it("RM11 projects public HTTP candidates from server.json and registry wrappers", () => {
  const preview = previewRegistryEntry(registryEntry());
  expect(preview).toMatchObject({ state: "previewed", name: "io.example/docs", version: "1.2.3",
    remotes: [{ endpoint: "https://mcp.example.com/mcp", transport: "streamable-http", mode: "connect", headers: [] }], packages: [] });
  expect(previewRegistryEntry({ server: registryEntry(), _meta: { unpublished: true } })).toEqual(preview);
});

it("RM11 keeps header names while discarding static secrets and environment values", () => {
  const preview = previewRegistryEntry({ ...registryEntry(), remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp",
    headers: [{ name: "Authorization", value: "Bearer static-secret", isSecret: true }], variables: { token: { default: "secret-variable" } } }] });
  expect(preview?.remotes[0]).toEqual({ endpoint: "https://mcp.example.com/mcp", transport: "streamable-http", mode: "configure", headers: ["Authorization"] });
  expect(JSON.stringify(preview)).not.toMatch(/static-secret|secret-variable|isSecret|variables/u);
});

it("RM11 describes stdio packages without producing launch commands or configuration", () => {
  const preview = previewRegistryEntry({ ...registryEntry(), remotes: [], packages: [{ registryType: "npm", identifier: "@example/mcp", version: "1.2.3",
    transport: { type: "stdio" }, runtimeHint: "npx", packageArguments: [{ type: "positional", value: "--unsafe" }],
    environmentVariables: [{ name: "TOKEN", value: "static-secret" }] }] });
  expect(preview?.packages).toEqual([{ registry: "npm", identifier: "@example/mcp", version: "1.2.3" }]);
  expect(preview?.remotes).toEqual([]);
  expect(JSON.stringify(preview)).not.toMatch(/npx|--unsafe|static-secret|TOKEN/u);
});

it.each(["http://mcp.example.com/mcp", "https://user:secret@mcp.example.com/mcp", "https://mcp.example.com/mcp?token=secret",
  "https://mcp.example.com/mcp#secret", "javascript:alert(1)", "file:///private", "not a url"])("RM11 rejects unsafe URL %s before producing a connect candidate", url => {
  expect(previewRegistryEntry({ ...registryEntry(), remotes: [{ type: "streamable-http", url }] })).toBeUndefined();
});

it.each(["https://localhost/mcp", "https://127.0.0.1/mcp", "https://service.internal/mcp", "https://{tenant}.example.com/mcp", "https://mcp.example.com/{workspace}/mcp"])("RM11 keeps %s as a configuration-only candidate", url => {
  expect(previewRegistryEntry({ ...registryEntry(), remotes: [{ type: "streamable-http", url }] })?.remotes[0]?.mode).toBe("configure");
});

it("RM11 bounds source JSON, collection sizes and malformed metadata", () => {
  expect(previewRegistryEntry({ ...registryEntry(), metadata: "x".repeat(MCP_REGISTRY_LIMITS.bytes) })).toBeUndefined();
  expect(previewRegistryEntry({ ...registryEntry(), remotes: new Array(MCP_REGISTRY_LIMITS.remotes + 1).fill(registryEntry().remotes[0]) })).toBeUndefined();
  expect(previewRegistryEntry({ ...registryEntry(), name: "" })).toBeUndefined();
  expect(previewRegistryEntry({ ...registryEntry(), remotes: [] })).toBeUndefined();
});
