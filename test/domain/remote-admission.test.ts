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
  const ports: RemoteCallPorts = { repository, profile: vi.fn(() => profile), identity,
    digest: fixtureDigest, connector: { validate: vi.fn(() => true), open: vi.fn(async (_profile, _signal, dispatched, authorize) => {
      await authorize(); mark = dispatched; return session;
    }) } };
  const command = { profile_id: profile.profile_id, tool_id: tool.tool_id, version: tool.version, arguments: { query: "fixture" } };
  const call = () => createRemoteCaller(ports)(principal, command, new AbortController().signal);
  return { profile, head, identity, ports, command, tool, call, invoked, closed, callTool, listTools,
    revoke: () => { allowed = false; }, after: (action: () => void) => { afterCall = action; } };
}

it("W09 governance denies before connecting and is not consulted for unauthorized calls", async () => {
  const f = await fixture(), admit = vi.fn(() => false), record = vi.fn();
  const call = createRemoteCaller({ ...f.ports, observation: { admit, record } });
  expect(await call({ client_id: 'client-test', secret_version: 1 }, f.command, new AbortController().signal)).toMatchObject({ code: 'busy', operation_state: 'not_started' });
  expect(f.ports.connector.open).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
  admit.mockClear(); f.revoke();
  expect(await call({ client_id: 'client-test', secret_version: 1 }, f.command, new AbortController().signal)).toMatchObject({ code: 'permission_denied' });
  expect(admit).not.toHaveBeenCalled();
});
it("W09 failed optional audit never converts a completed result into an error or replay", async () => {
  const f = await fixture(), record = vi.fn(() => { throw new Error('history unavailable'); });
  const call = createRemoteCaller({ ...f.ports, observation: { admit: () => true, record } });
  expect(await call({ client_id: 'client-test', secret_version: 1 }, f.command, new AbortController().signal)).toMatchObject({ state: 'completed', operation_state: 'completed' });
  expect(f.invoked).toHaveBeenCalledOnce(); expect(record).toHaveBeenCalledOnce();
});

it("W05 a central-only identity completes one reviewed call without a Runner", async () => {
  const f = await fixture();
  expect(await f.call()).toMatchObject({ state: "completed", operation_state: "completed", result: { content: [{ text: "fixture" }] } });
  expect(f.invoked).toHaveBeenCalledOnce(); expect(f.closed).toHaveBeenCalledOnce();
});

it("shared remote publications allow two independent clients without grant ports", async () => {
  const f = await fixture();
  f.ports.identity = async p => ({ state: "allowed", identity: { ...p, schema_version: 2, label: "Shared client", native_scopes: [] } });
  for (const client_id of ["first", "second"]) {
    expect(await createRemoteCaller(f.ports)({ client_id, secret_version: 1 }, f.command, new AbortController().signal)).toMatchObject({ state: "completed" });
  }
  expect(f.invoked).toHaveBeenCalledTimes(2);
  f.profile.enabled = false;
  expect(await createRemoteCaller(f.ports)({ client_id: "first", secret_version: 1 }, f.command, new AbortController().signal)).toMatchObject({ code: "permission_denied", operation_state: "not_started" });
  expect(f.invoked).toHaveBeenCalledTimes(2);
});

it("W05 revoked identity denies before probing a profile or upstream", async () => {
  const f = await fixture(); f.revoke();
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

it.each(["identity", "catalog", "profile"])("W05 a %s change during upstream discovery fences the call", async changed => {
  const f = await fixture();
  f.listTools.mockImplementation(async () => {
    if (changed === "identity") f.revoke();
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
