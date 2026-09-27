import { expect, it } from "vitest";
import type { RunnerPolicy } from "@aloneio/runmesh-protocol";
import { LOCKED_PERMISSIONS, type PolicyVersionRow } from "../../apps/worker/src/registry/records.js";
import {
  parseRunnerConnection, parseRunnerHeartbeat, parseRunnerSession, parseRunnerDisconnect, parseRunnerSync,
  parseJobFilters, parseMcpCallFilters, parseMcpCall, parseAdminSession, parseMcpIdentity,
  parseNativeMcpClient, parseManagedWorkspace, parseRunnerVersionPolicy,
} from "../../apps/worker/src/registry/route-inputs.js";
import {
  registryInputError, projectActiveWorkspaces, projectPolicyVersions, projectPolicyRevision, projectCombinedMcpCalls,
} from "../../apps/worker/src/registry/route-projections.js";

const transport = { epoch: 1, credential_version: 2, now_ms: 100, lifecycle_id: "lifecycle-12345678", session_id: "session-1" };

it("route parsers preserve transport identity requirements and disconnect states", () => {
  for (const parse of [parseRunnerHeartbeat, parseRunnerSession]) {
    expect(parse(transport)).toMatchObject({ ok: true, value: { epoch: 1, credentialVersion: 2, identity: { valid: true } } });
    for (const input of [{ ...transport, session_id: undefined }, { ...transport, lifecycle_id: "short" }, { ...transport, epoch: -1 }])
      expect(parse(input)).toMatchObject({ ok: false, status: 400 });
  }
  for (const state of ["offline", "stale"])
    expect(parseRunnerDisconnect({ ...transport, state })).toMatchObject({ ok: true, value: { state } });
  expect(parseRunnerDisconnect({ ...transport, state: "online" })).toEqual({ ok: false, status: 400, error: "invalid disconnect" });
});

it("connection parsing preserves protocol bounds and schema validation", () => {
  const input = { ...transport, min_protocol_version: 1, max_protocol_version: 2, metadata: {
    runner_id: "runner-1", runner_version: "0.1.5", platform: "linux", architecture: "x64",
    capabilities: { filesystem: true, process_execution: true, workspace_sync: true, pty: false,
      network_access: true, max_concurrent_jobs: 2, supported_rpc_methods: [], labels: {} },
  } };
  expect(parseRunnerConnection(input)).toMatchObject({ ok: true, value: { protocolMin: 1, protocolMax: 2 } });
  for (const bounds of [[0, 1], [2, 1], [1, 1001]])
    expect(parseRunnerConnection({ ...input, min_protocol_version: bounds[0], max_protocol_version: bounds[1] })).toMatchObject({ ok: false });
  expect(parseRunnerConnection({ ...input, metadata: { ...input.metadata, extra: true } })).toMatchObject({ ok: false });
});

it("sync parsing retains the caller runner binding", () => {
  const input = { ...transport, message: { protocol_version: 1, type: "runner.sync", runner_id: "runner-1", sync_sequence: 1, sent_at_ms: 100, workspaces: [], jobs: [] } };
  expect(parseRunnerSync(input, "runner-1")).toMatchObject({ ok: true });
  expect(parseRunnerSync(input, "runner-2")).toEqual({ ok: false, status: 400, error: "invalid sync" });
});

it("history filters reject malformed or unbounded limits without changing defaults", () => {
  for (const parse of [parseJobFilters, parseMcpCallFilters]) {
    expect(parse(new URL("https://registry.invalid/"))).toMatchObject({ ok: true, value: { limit: undefined } });
    for (const limit of ["1", "100"]) expect(parse(new URL("https://registry.invalid/?limit=" + limit))).toMatchObject({ ok: true, value: { limit: Number(limit) } });
    for (const limit of ["", "0", "101", "1.5", "-1", "Infinity", "1e2"])
      expect(parse(new URL("https://registry.invalid/?limit=" + limit))).toMatchObject({ ok: false, status: 400 });
  }
  expect(parseJobFilters(new URL("https://registry.invalid/?status=unknown&workspace_id=workspace-1"))).toMatchObject({ ok: true, value: { status: "unknown", workspaceId: "workspace-1" } });
  expect(parseJobFilters(new URL("https://registry.invalid/?status=bogus"))).toMatchObject({ ok: false });
});

it("MCP call parsing checks elapsed time and normalizes absent optional metadata", () => {
  const input = { ...transport, call_id: "call-1234567890", client_id: "client-1", method: "tools/call", status: "ok", started_at_ms: 10, completed_at_ms: 30, duration_ms: 20 };
  expect(parseMcpCall(input)).toMatchObject({ ok: true, value: { durationMs: 20, errorCode: null, workspaceId: null, jobId: null } });
  expect(parseMcpCall({ ...input, duration_ms: 19 })).toEqual({ ok: false, status: 400, error: "invalid MCP call duration" });
  expect(parseMcpCall({ ...input, workspace_id: 1 })).toMatchObject({ ok: false });
});

it("session parsing uses its supplied time and preserves the strict expiry boundary", () => {
  const input = { session_hash: "a".repeat(64), csrf_hash: "b".repeat(64), expected_session_version: 1, expires_at_ms: 200 };
  expect(parseAdminSession(input, 199)).toMatchObject({ ok: true, value: { expires: 200 } });
  expect(parseAdminSession(input, 200)).toEqual({ ok: false, status: 400, error: "invalid session" });
  expect(parseAdminSession({ ...input, expected_session_version: 0 }, 199)).toMatchObject({ ok: false });
});

it("identity parsing preserves shared central access and rejects mixed scope fields", () => {
  const identity = { identity_version: 2, client_id: "client-1", label: "Client", secret_verifier: "a".repeat(64), secret_prefix: "prefix", native_scopes: [] };
  expect(parseMcpIdentity(identity)).toMatchObject({ ok: true, value: { scopes: [] } });
  expect(parseMcpIdentity({ ...identity, scopes: [] })).toEqual({ ok: false, status: 400, error: "invalid identity version or mixed scope fields" });
  expect(parseMcpIdentity({ ...identity, identity_version: 1 })).toMatchObject({ ok: false });
  expect(parseNativeMcpClient({ ...identity, scopes: ["invalid"] })).toMatchObject({ ok: false });
});

it("workspace and version policy parsing preserve mutation and channel constraints", () => {
  const workspace = { workspace_id: "workspace-1", display_name: "Workspace", root_path: "/data", enabled: false, permissions: LOCKED_PERMISSIONS, mutation_id: "mutation-1234567890" };
  expect(parseManagedWorkspace(workspace)).toMatchObject({ ok: true, value: { enabled: false, rootPath: "/data" } });
  expect(parseManagedWorkspace({ ...workspace, enabled: "false" })).toMatchObject({ ok: false });
  expect(parseManagedWorkspace({ ...workspace, mutation_id: undefined })).toMatchObject({ ok: false });
  for (const update_channel of ["stable", "pinned"])
    expect(parseRunnerVersionPolicy({ update_channel })).toMatchObject({ ok: true, value: { channel: update_channel } });
  expect(parseRunnerVersionPolicy({ update_channel: "dev" })).toMatchObject({ ok: false });
  expect(parseRunnerVersionPolicy({ update_channel: "pinned", desired_runner_version: 1 })).toMatchObject({ ok: false });
});

it("error projections preserve JSON status and message", async () => {
  const response = registryInputError({ status: 400, error: "invalid disconnect" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid disconnect" });
});

it("workspace projections do not leak local roots or unrelated policy fields", () => {
  const policy: RunnerPolicy = { schema_version: 1, runner_id: "runner-1", revision: 3, checksum: "a".repeat(64), runner_permissions: LOCKED_PERMISSIONS,
    workspaces: [{ workspace_id: "workspace-1", display_name: "Private", root_path: "/private/root", enabled: true, permissions: LOCKED_PERMISSIONS }] };
  expect(projectActiveWorkspaces("runner-1", policy)).toEqual({ runner_id: "runner-1", revision: 3, checksum: "a".repeat(64),
    workspaces: [{ workspace_id: "workspace-1", enabled: true, permissions: LOCKED_PERMISSIONS }] });
});

it("policy history projects only reviewed fields with shortened checksums", () => {
  const version: PolicyVersionRow = { runner_id: "runner-1", revision: 3, checksum: "a".repeat(64), policy_json: '{"root":"private"}', status: "applied",
    created_at_ms: 100, acknowledged_at_ms: 101, source_revision: 2, mutation_id: "mutation-1", validation_summary_json: '{"valid":true}' };
  expect(projectPolicyVersions("runner-1", [version])).toEqual({ runner_id: "runner-1", versions: [{
    revision: 3, checksum: "a".repeat(12), status: "applied", created_at_ms: 100, acknowledged_at_ms: 101,
    source_revision: 2, mutation_id: "mutation-1", validation_summary: { valid: true },
  }] });
  expect(projectPolicyVersions("runner-1", [{ ...version, validation_summary_json: null }]).versions[0]!.validation_summary).toBeNull();
});

it("policy revision projection preserves unknown values and supplied mutation identity", () => {
  const runner = { desired_policy_revision: 3, desired_policy_checksum: "a", applied_policy_revision: null,
    active_policy_checksum: null, runner_reported_policy_revision: null, runner_reported_policy_checksum: null, policy_status: "pending" as const };
  expect(projectPolicyRevision(runner, undefined)).toEqual({ ...runner, desired_policy_mutation_id: null });
  expect(projectPolicyRevision(runner, "mutation-1").desired_policy_mutation_id).toBe("mutation-1");
});

it("combined audit history deduplicates external rows, sorts ties and limits without mutating inputs", () => {
  const local = [{ call_id: "same", completed_at_ms: 10 }, { call_id: "a", completed_at_ms: 30 }];
  const external = [{ call_id: "same", completed_at_ms: 20 }, { call_id: "b", completed_at_ms: 30 }];
  expect(projectCombinedMcpCalls("runner-1", local, external)).toEqual({ runner_id: "runner-1", history_backend: "d1",
    calls: [external[1], local[1], external[0]] });
  expect(projectCombinedMcpCalls("runner-1", local, external, 1).calls).toEqual([external[1]]);
  expect(local[0]!.completed_at_ms).toBe(10);
  expect(external.map(row => row.call_id)).toEqual(["same", "b"]);
});
