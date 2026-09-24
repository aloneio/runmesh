import { expect, it, vi } from "vitest";
import { createRemoteCaller } from "../../apps/worker/src/application/capabilities/remote-call.js";
import { createRemoteDiscovery } from "../../apps/worker/src/application/capabilities/remote-discovery.js";
import { REMOTE_LIMITS, RemoteFault, type RemoteCallPorts, type RemoteResult, type RemoteSession } from "../../apps/worker/src/contracts/remote.js";
import type { CatalogRepository } from "../../apps/worker/src/contracts/catalog.js";
import type { IdentityDecision } from "../../apps/worker/src/contracts/identity.js";
import { catalogDefinition, catalogProfile, catalogSnapshot, fixtureDigest } from "./catalog-fixtures.js";

async function fixture() {
  const snapshot = await catalogSnapshot(), profile = catalogProfile(), tool = snapshot.tools[0]!;
  const principal = { client_id: "client-test", secret_version: 1 };
  let allowed = true;
  const grant = { schema_version: 1 as const, client_id: principal.client_id, revision: 1, enabled: true,
    rules: [{ kind: "remote_tool" as const, resource_id: tool.tool_id, version: tool.version, connection_profile_id: profile.profile_id }] };
  const head = { schema_version: 1 as const, profile_id: profile.profile_id, revision: 2,
    observed_digest: snapshot.digest, approved_digest: snapshot.digest, approved_names: [tool.definition.name] };
  const identity = vi.fn(async (): Promise<IdentityDecision> => allowed ? { state: "allowed", identity: {
    schema_version: 2, ...principal, label: "Central only", native_scopes: [] } } : { state: "denied" });
  const invoked = vi.fn(), closed = vi.fn(async () => undefined);
  let mark = () => undefined;
  let afterCall: () => void = () => undefined;
  const callTool = vi.fn(async (_tool, _args, before: () => Promise<void>): Promise<RemoteResult> => {
    await before(); mark(); invoked(); afterCall(); return { content: [{ type: "text", text: "fixture" }], isError: false };
  });
  const listTools = vi.fn(async () => [tool.definition]);
  const session: RemoteSession = { listTools, callTool, close: closed };
  const repository: CatalogRepository = { readHead: () => head, readSnapshot: () => snapshot,
    stage: vi.fn(() => ({ state: "written", head })), approve: () => ({ state: "invalid" }), disable: () => ({ state: "invalid" }) };
  const ports: RemoteCallPorts = { repository, profile: vi.fn(() => profile), grant: () => grant, identity,
    digest: fixtureDigest, connector: { validate: vi.fn(() => true), open: vi.fn(async (_profile, _signal, dispatched, authorize) => {
      await authorize(); mark = dispatched; return session;
    }) } };
  const command = { profile_id: profile.profile_id, tool_id: tool.tool_id, version: tool.version, arguments: { query: "fixture" } };
  const call = () => createRemoteCaller(ports)(principal, command, new AbortController().signal);
  return { profile, grant, head, identity, ports, command, tool, call, invoked, closed, callTool, listTools,
    revoke: () => { allowed = false; }, after: (action: () => void) => { afterCall = action; } };
}

it("W05 a central-only identity completes one reviewed call without a Runner", async () => {
  const f = await fixture();
  expect(await f.call()).toMatchObject({ state: "completed", operation_state: "completed", result: { content: [{ text: "fixture" }] } });
  expect(f.invoked).toHaveBeenCalledOnce(); expect(f.closed).toHaveBeenCalledOnce();
});

it("W05 no grant denies before probing a profile or upstream", async () => {
  const f = await fixture(); f.grant.enabled = false;
  expect(await f.call()).toEqual({ state: "failed", code: "permission_denied", operation_state: "not_started" });
  expect(f.ports.profile).not.toHaveBeenCalled(); expect(f.ports.connector.open).not.toHaveBeenCalled();
});

it("W05 invalid arguments are rejected before decrypting or connecting", async () => {
  const f = await fixture(); f.ports.connector.validate = vi.fn(() => false);
  expect(await f.call()).toEqual({ state: "failed", code: "invalid_arguments", operation_state: "not_started" });
  expect(f.ports.connector.open).not.toHaveBeenCalled();
});

it.each(["description", "missing"])("W05 live tool %s drift does not dispatch", async change => {
  const f = await fixture(); f.listTools.mockResolvedValue(change === "missing" ? [] : [{ ...f.tool.definition, description: "Unreviewed change" }]);
  expect(await f.call()).toEqual({ state: "failed", code: "stale_catalog", operation_state: "not_started" });
  expect(f.invoked).not.toHaveBeenCalled(); expect(f.closed).toHaveBeenCalledOnce();
});

it.each(["identity", "grant", "catalog", "profile"])("W05 a %s change during upstream discovery fences the call", async changed => {
  const f = await fixture();
  f.listTools.mockImplementation(async () => {
    if (changed === "identity") f.revoke();
    if (changed === "grant") f.grant.revision++;
    if (changed === "catalog") f.head.revision++;
    if (changed === "profile") f.profile.revision++;
    return [f.tool.definition];
  });
  expect(await f.call()).toMatchObject({ state: "failed", operation_state: "not_started" });
  expect(f.invoked).not.toHaveBeenCalled();
});

it("W05 revocation after execution withholds output without pretending to undo the action", async () => {
  const f = await fixture(); f.after(f.revoke);
  expect(await f.call()).toEqual({ state: "failed", code: "result_withheld", operation_state: "completed" });
  expect(f.invoked).toHaveBeenCalledOnce();
});

it("W05 lost response after dispatch is unknown and never replayed", async () => {
  const f = await fixture(); f.after(() => { throw new RemoteFault("upstream_unavailable"); });
  expect(await f.call()).toEqual({ state: "failed", code: "upstream_unavailable", operation_state: "unknown" });
  expect(f.invoked).toHaveBeenCalledOnce(); expect(f.callTool).toHaveBeenCalledOnce();
});

it("W05 upstream isError remains a valid completed result", async () => {
  const f = await fixture(), original = f.callTool.getMockImplementation()!;
  f.callTool.mockImplementation(async (...args) => ({ ...await original(...args), isError: true }));
  expect(await f.call()).toMatchObject({ state: "completed", operation_state: "completed", result: { isError: true } });
});

it("W05 cancelled admission never invokes the connector", async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort();
  expect(await createRemoteCaller(f.ports)({ client_id: "client-test", secret_version: 1 }, f.command, controller.signal))
    .toEqual({ state: "failed", code: "operation_timed_out", operation_state: "not_started" });
  expect(f.ports.connector.open).not.toHaveBeenCalled();
});

it("W05 a stalled identity has a bounded deadline and no surviving timeout", async () => {
  const f = await fixture(); vi.useFakeTimers();
  try {
    f.identity.mockImplementation(() => new Promise(() => undefined));
    const pending = f.call(); await vi.advanceTimersByTimeAsync(REMOTE_LIMITS.operation_ms + 1);
    expect(await pending).toEqual({ state: "failed", code: "operation_timed_out", operation_state: "not_started" });
    expect(vi.getTimerCount()).toBe(0); expect(f.ports.connector.open).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("W05 failed discovery does not stage a partial or empty successful replacement", async () => {
  const f = await fixture(); f.listTools.mockRejectedValue(new RemoteFault("upstream_protocol_error"));
  const discover = createRemoteDiscovery({ repository: f.ports.repository, profile: f.ports.profile,
    authorize: async () => "allowed", digest: fixtureDigest, connector: f.ports.connector });
  expect(await discover("docs", 2, new AbortController().signal)).toMatchObject({ state: "failed", operation_state: "not_started" });
  expect(f.ports.repository.stage).not.toHaveBeenCalled();
});

it("W05 successful discovery only stages complete tool definitions", async () => {
  const f = await fixture(), stage = vi.fn(() => ({ state: "written" as const, head: { ...f.head, revision: 3 } }));
  f.ports.repository.stage = stage;
  f.listTools.mockResolvedValue([catalogDefinition()]);
  const discover = createRemoteDiscovery({ repository: f.ports.repository, profile: f.ports.profile,
    authorize: async () => "allowed", digest: fixtureDigest, connector: f.ports.connector });
  expect(await discover("docs", 2, new AbortController().signal)).toMatchObject({ state: "written", head: { revision: 3 } });
  expect(stage).toHaveBeenCalledOnce(); expect(f.invoked).not.toHaveBeenCalled();
});
