import { describe, expect, it, vi } from "vitest";
import { failureMetadata, isKnownRpcFailureCode, RPC_FAILURE_CODES, PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { callRunner, registryCall, registryPostCall } from "../src/mcp/transport.js";
import { getActiveRunnerSelection, resolveActiveRunner, selectActiveRunner } from "../src/mcp/selection.js";
import { jobTool } from "../src/mcp/handlers/jobs.js";
import { checkPermission, checkAnyReadPermission, policyReadiness } from "../src/mcp/authorization.js";
import { failure, failureWithDetails, runnerFailure, hintFor } from "../src/mcp/results/envelope.js";
import type { McpRequestEnv, ActiveSelection } from "../src/mcp/contracts.js";

const checksum = "a".repeat(64);
const selection: ActiveSelection = { runnerId: "runner-test", context: { runner_id: "runner-test", state: "online", available: true, updated_at_ms: 1, automatic_selection: false } };
function fixture(reply: () => Response = () => Response.json({ type: "rpc.response", result: {} })) {
  const dispatch = vi.fn(async () => reply());
  const registry = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/active-runner")) return Response.json({ active_runner_id: "runner-test", active_runner_updated_at_ms: 1, runner: selection.context });
    if (path.includes("/effective-permissions/")) return Response.json({ permissions: { read: true, edit: true, shell: true, job_control: true } });
    if (path.endsWith("/policy-readiness")) return Response.json({ ok: true, policy_status: "applied", desired_revision: 1, applied_revision: 1, runner_reported_policy_revision: 1,
      desired_checksum: checksum, active_checksum: checksum, runner_reported_policy_checksum: checksum, connection_epoch: 1, credential_version: 1, lifecycle_id: checksum, session_id: "session-test" });
    if (path.includes("/jobs/")) return new Response(null, { status: 404 });
    if (path.endsWith("/authorize-rpc")) return Response.json({ ok: true });
    if (path.endsWith("/mcp-calls")) return Response.json({ audit_status: "recorded" });
    throw new Error(`Unexpected test route: ${path}`);
  });
  const env = { INTERNAL_CONTROL_SECRET: "test-internal-control-secret-not-for-production", mcpPrincipal: { client_id: "client-test", secret_version: 1 },
    REGISTRY: { idFromName: (name: string) => name, get: () => ({ fetch: registry }) },
    RUNNER: { idFromName: (name: string) => name, get: () => ({ fetch: dispatch }) } } as unknown as McpRequestEnv;
  return { env, dispatch, registry };
}
const invoke = (env: McpRequestEnv) => callRunner(env, "runner-test", "fs.read", { workspace_id: "work", path: "file.txt" }, 1, checksum);

describe("fixed MCP Registry failure diagnostics", () => {
  it.each([
    ["/auth/clients/private-client/active-runner", "mcp_active_runner"],
    ["/auth/clients/private-client/effective-permissions/private-runner?workspace_id=private-workspace", "mcp_permissions"],
    ["/auth/clients/private-client/effective-workspaces/private-runner", "mcp_workspaces"],
    ["/runners/private-runner/policy-readiness", "mcp_policy_readiness"],
    ["/runners/private-runner/jobs/private-job?include=private-query", "mcp_job_snapshot"],
    ["/private-other?private-query=private-value", "mcp_registry_read"],
  ])("classifies a failed read at %s without retaining route data", async (path, stage) => {
    const f = fixture(), warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new Error("Network connection lost."); error.stack = "private-stack";
    f.registry.mockRejectedValueOnce(error);
    try {
      expect(await registryCall(f.env, path)).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: "not_started" } });
      expect(f.registry).toHaveBeenCalledOnce(); expect(f.dispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith("RUNMESH_CONTROL_PLANE_FAILURE stage=" + stage + " outcome=exception kind=error reason=network_connection_lost status=none phase=fetch");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
    } finally { warn.mockRestore(); }
  });

  it.each(["read", "post"] as const)("retains the existing %s failed-status semantics", async kind => {
    const f = fixture(), warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.registry.mockImplementation(async () => new Response("private-status-body", { status: 503 }));
    try {
      const result = kind === "read" ? await registryCall(f.env, "/private-read") : await registryPostCall(f.env, "/private-post", {});
      expect(result).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: kind === "read" ? "not_started" : "unknown" } });
      expect(f.registry).toHaveBeenCalledOnce(); expect(f.dispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith("RUNMESH_CONTROL_PLANE_FAILURE stage=mcp_registry_" + kind + " outcome=unexpected_status kind=other reason=unknown status=503 phase=fetch");
    } finally { warn.mockRestore(); }
  });

  it.each([200, 403, 409])("records malformed authorization at HTTP %s without dispatching", async status => {
    const f = fixture(), warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.registry.mockImplementation(async () => Response.json({ ok: status === 200 ? "private-value" : true }, { status }));
    try {
      expect(await invoke(f.env)).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: "not_started" } });
      expect(f.registry).toHaveBeenCalledOnce(); expect(f.dispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith("RUNMESH_CONTROL_PLANE_FAILURE stage=mcp_rpc_authorization outcome=invalid_receipt kind=other reason=unknown status=" + status);
    } finally { warn.mockRestore(); }
  });

  it.each(["fetch", "body_read", "json_parse"] as const)("forwards the 200 authorization deadline phase %s without dispatching", async phase => {
    let elapsed = 0;
    const f = fixture(), clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = JSON.stringify({ ok: true }), parse = JSON.parse;
    const parsed = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const value = parse(text, reviver);
      if (phase === "json_parse" && text === body) elapsed = 5001;
      return value;
    });
    f.registry.mockImplementation(async () => {
      if (phase === "fetch") elapsed = 5001;
      return phase === "body_read" ? new Response(new ReadableStream({
        pull(controller) { elapsed = 5001; controller.close(); },
      }, { highWaterMark: 0 })) : new Response(body);
    });
    try {
      expect(await invoke(f.env)).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: "not_started" } });
      expect(f.registry).toHaveBeenCalledOnce(); expect(f.dispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith(`RUNMESH_CONTROL_PLANE_FAILURE stage=mcp_rpc_authorization outcome=deadline kind=other reason=unknown status=200 phase=${phase}`);
    } finally { parsed.mockRestore(); warn.mockRestore(); clock.mockRestore(); }
  });

  it("leaves normal missing records, explicit denials, and completed receipts quiet", async () => {
    const f = fixture(), warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      f.registry.mockImplementation(async () => new Response("private-missing", { status: 404 }));
      expect(await registryCall(f.env, "/private-read")).toMatchObject({ ok: false, error: { code: "not_found", operation_state: "not_started" } });
      expect(await registryPostCall(f.env, "/private-post", {})).toMatchObject({ ok: false, error: { code: "not_found", operation_state: "unknown" } });
      for (const status of [200, 403, 409]) {
        f.registry.mockImplementation(async () => Response.json({ ok: false, code: "permission_denied" }, { status }));
        expect(await invoke(f.env)).toMatchObject({ ok: false, error: { code: "permission_denied", operation_state: "not_started" } });
      }
      for (const audit_status of ["disabled", "degraded"]) {
        f.registry.mockImplementation(async () => Response.json({ audit_status }, { status: 202 }));
        expect(await registryPostCall(f.env, "/private-audit", {}, "audit")).toEqual({ ok: true, value: { audit_status } });
      }
      f.registry.mockImplementation(async () => Response.json({ ok: true }));
      expect(await registryCall(f.env, "/private-read")).toEqual({ ok: true, value: { ok: true } });
      expect(await registryPostCall(f.env, "/private-post", {})).toEqual({ ok: true, value: { ok: true } });
      expect(f.registry).toHaveBeenCalledTimes(9); expect(f.dispatch).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it.each(["read", "post"] as const)("preserves the original %s signing exception before dispatch", async kind => {
    const f = fixture(), warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new Error("private-signing-error"), sign = vi.spyOn(crypto.subtle, "sign").mockRejectedValueOnce(error);
    try {
      const result = kind === "read" ? registryCall(f.env, "/private-read") : registryPostCall(f.env, "/private-post", {});
      await expect(result).rejects.toBe(error);
      expect(f.registry).not.toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith("RUNMESH_CONTROL_PLANE_FAILURE stage=mcp_registry_" + kind + " outcome=exception kind=error reason=unknown status=none");
    } finally { sign.mockRestore(); warn.mockRestore(); }
  });
});

describe("stable failures across Runner, bridge and MCP", () => {
  it.each(RPC_FAILURE_CODES)("classifies and forwards %s without another allow-list", async code => {
    const expected = failureMetadata(code);
    expect(expected.failure_class).not.toBe("unknown");
    const f = fixture(() => Response.json({ type: "rpc.error", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "reply-test",
      error: { code, operation_state: expected.operation_state, message: "/private/operator-token", details: { root: "/private" } } }, { status: 502 }));
    const result = await invoke(f.env);
    expect(result).toMatchObject({ ok: false, error: { code, ...expected } });
    expect(JSON.stringify(result)).not.toContain("/private");
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown_code", "__proto__", "constructor", "token-sensitive-code"])("does not trust unknown code %s or its claimed safe state", async code => {
    expect(isKnownRpcFailureCode(code)).toBe(false);
    const f = fixture(() => Response.json({ error: { code, operation_state: "not_started", retry_after_ms: 1 } }, { status: 503 }));
    expect(await invoke(f.env)).toMatchObject({ ok: false, error: { code: "runner_rpc_failed", failure_class: "internal", operation_state: "unknown", next_action: "contact_operator" } });
  });
  it.each([200, 502, 503, 504])("does not infer offline or success from malformed HTTP %s", async status => {
    const f = fixture(() => new Response("not a protocol reply", { status }));
    expect(await invoke(f.env)).toMatchObject({ ok: false, error: { code: "runner_rpc_failed", operation_state: "unknown" } });
  });
  it.each([429, 500, 503])("does not dispatch when authorization dependency returns %s", async status => {
    const f = fixture();
    f.registry.mockImplementation(async () => new Response(null, { status }));
    expect(await invoke(f.env)).toMatchObject({ ok: false, error: { failure_class: "availability", operation_state: "not_started", next_action: "wait_and_retry" } });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("does not dispatch when the final authorization decision denies the call", async () => {
    const f = fixture();
    f.registry.mockImplementation(async () => Response.json({ ok: false, code: "permission_denied" }, { status: 403 }));
    expect(await invoke(f.env)).toMatchObject({ ok: false, error: { code: "permission_denied", operation_state: "not_started" } });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each([201, 202, 206, 207, 403, 409])("does not accept an authorization grant carried by HTTP %s", async status => {
    const f = fixture();
    f.registry.mockImplementation(async () => Response.json({ ok: true, code: "permission_denied" }, { status }));
    expect(await invoke(f.env)).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: "not_started" } });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each([201, 202, 203, 206, 207])("keeps an RPC success payload carried by HTTP %s ambiguous", async status => {
    const f = fixture(() => Response.json({ type: "rpc.response", result: {} }, { status }));
    expect(await invoke(f.env)).toMatchObject({ ok: false, error: { code: "runner_rpc_failed", operation_state: "unknown" } });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it.each([201, 202, 203, 206, 207])("rejects an incomplete Registry snapshot carried by HTTP %s", async status => {
    const f = fixture();
    f.registry.mockImplementation(async () => Response.json({ permissions: { read: true } }, { status }));
    expect(await registryCall(f.env, "/snapshot")).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: "not_started" } });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each(["read", "mutation"] as const)("cancels an incomplete %s receipt without waiting for its unfinished body", async kind => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel });
    const f = fixture();
    f.registry.mockImplementation(async () => new Response(body, { status: 202 }));
    const result = kind === "read" ? await registryCall(f.env, "/snapshot") : await registryPostCall(f.env, "/mutation", {});
    expect(result).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: kind === "read" ? "not_started" : "unknown" } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.registry).toHaveBeenCalledTimes(1);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each(["disabled", "degraded"])("retains the documented %s audit receipt without permitting an authorization grant", async audit_status => {
    const f = fixture();
    f.registry.mockImplementation(async () => Response.json({ audit_status }, { status: 202 }));
    expect(await registryPostCall(f.env, "/audit", {}, "audit")).toEqual({ ok: true, value: { audit_status } });
    expect(await invoke(f.env)).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: "not_started" } });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each(["recorded", "unknown", undefined, "invalid"])("does not fabricate a %s audit completion from HTTP 202", async audit_status => {
    const f = fixture();
    f.registry.mockImplementation(async () => Response.json({ audit_status }, { status: 202 }));
    expect(await registryPostCall(f.env, "/audit", {}, "audit")).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: "unknown" } });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("keeps lost replies ambiguous and never replays the command", async () => {
    const f = fixture();
    f.dispatch.mockRejectedValueOnce(new Error("connection reset"));
    const result = await invoke(f.env);
    expect(result).toMatchObject({ ok: false, error: { code: "runner_offline", operation_state: "unknown", next_action: "inspect_job" } });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("sticky Runner selection receipt integrity", () => {
  it.each([
    null, {}, [],
    { active_runner_id: "runner-selected", active_runner_updated_at_ms: 1, runner: selection.context },
    { active_runner_id: null, active_runner_updated_at_ms: null, runner: selection.context },
    { active_runner_id: "runner-test", active_runner_updated_at_ms: 1, runner: { ...selection.context, available: "false" } },
    { active_runner_id: "runner-test", active_runner_updated_at_ms: 1, runner: { ...selection.context, state: "unknown" } },
  ])("rejects malformed or mismatched sticky state without selecting another Runner: %j", async value => {
    const f = fixture();
    f.registry.mockImplementation(async () => Response.json(value));
    expect(await resolveActiveRunner(f.env, "client-test")).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: "not_started" } });
    expect(f.registry).toHaveBeenCalledTimes(1);
    expect(f.registry.mock.calls[0]![0].method).toBe("GET");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ok: "true" }, { ok: true, changed: true, selection: { active_runner_id: "runner-other", active_runner_updated_at_ms: 1, runner: { ...selection.context, runner_id: "runner-other" } } }])("does not confirm a malformed or misdirected selection mutation: %j", async value => {
    const f = fixture();
    f.registry.mockImplementation(async () => Response.json(value));
    expect(await selectActiveRunner(f.env, "client-test", "runner-test", false)).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: "unknown" } });
    expect(f.registry).toHaveBeenCalledTimes(1);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each(["online", "offline", "stale", "unavailable"] as const)("retains a valid %s selection while removing unrelated internal fields", async state => {
    const f = fixture();
    const context = { ...selection.context, state, available: state === "online" };
    f.registry.mockImplementation(async () => Response.json({ active_runner_id: "runner-test", active_runner_updated_at_ms: 1,
      runner: { ...context, root: "/private" }, operator_token: "private-token" }));
    const result = await getActiveRunnerSelection(f.env, "client-test");
    expect(result).toEqual({ ok: true, value: { active_runner_id: "runner-test", active_runner_updated_at_ms: 1,
      runner: { runner_id: "runner-test", state, available: state === "online", updated_at_ms: 1 } } });
    expect(JSON.stringify(result)).not.toMatch(/private|automatic_selection/);
  });
  it.each([true, false])("retains a completed selection receipt with changed=%s", async changed => {
    const f = fixture();
    f.registry.mockImplementation(async () => Response.json({ ok: true, changed,
      selection: { active_runner_id: "runner-test", active_runner_updated_at_ms: 1, runner: selection.context } }));
    expect(await selectActiveRunner(f.env, "client-test", "runner-test", false)).toMatchObject({ ok: true, value: { changed, selection: { active_runner_id: "runner-test" } } });
    expect(f.registry).toHaveBeenCalledTimes(1);
  });
  it.each(["client_not_found", "runner_not_found", "runner_unavailable", "runner_switch_confirmation_required"])("retains the explicit %s selection denial", async code => {
    const f = fixture();
    f.registry.mockImplementation(async () => Response.json({ ok: false, code,
      selection: { active_runner_id: "runner-test", active_runner_updated_at_ms: 1, runner: selection.context } }, { status: 409 }));
    expect(await selectActiveRunner(f.env, "client-test", "runner-other", false)).toMatchObject({ ok: false, error: { code } });
    expect(f.registry).toHaveBeenCalledTimes(1);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});

describe("agent-visible recovery receipts", () => {
  it.each([undefined, "pending", "offline_pending", "invalid"])("does not turn policy state %s into applied or dispatch a Job", async policy_status => {
    const f = fixture();
    const read = f.registry.getMockImplementation()!;
    f.registry.mockImplementation(async request => {
      const response = await read(request);
      if (!new URL(request.url).pathname.endsWith("/policy-readiness")) return response;
      return Response.json({ ...await response.json() as Record<string, unknown>, policy_status });
    });
    expect(await policyReadiness(f.env, "runner-test")).toMatchObject({ ok: false, error: { error: { code: "policy_pending" } } });
    expect(await jobTool(f.env, "client-test", { action: "get", job_id: "job-original", workspace_id: "work" }, ["coding:read"])).toMatchObject({ isError: true, structuredContent: { error: { code: "policy_pending" } } });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("does not misclassify a policy dependency outage as stale policy", async () => {
    const f = fixture();
    f.registry.mockImplementation(async () => new Response(null, { status: 503 }));
    expect(await policyReadiness(f.env, "runner-test")).toMatchObject({ ok: false, error: { error: { code: "registry_unavailable", operation_state: "not_started", next_action: "wait_and_retry" } } });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each([null, {}, { permissions: { read: "false" } }])("does not turn malformed workspace permissions into a grant rejection: %j", async value => {
    const f = fixture();
    f.registry.mockImplementation(async () => Response.json(value));
    expect(await checkPermission(f.env, "client-test", "runner-test", "work", "read")).toMatchObject({ error: { code: "authorization_response_invalid", operation_state: "not_started" } });
  });
  describe("any readable workspace observation", () => {
    const snapshotPath = "/runners/runner-test/snapshot-authorization";
    const listPath = "/auth/clients/client-test/effective-workspaces/runner-test";
    const receipt = (workspaces: unknown[]) => ({ runner_id: "runner-test", revision: 1, checksum, workspaces });

    it.each([false, true])("uses two Registry reads for 64 workspaces when the last workspace is readable=%s", async lastReadable => {
      const f = fixture();
      const workspaces = Array.from({ length: 64 }, (_, index) => ({ workspace_id: `work-${index}`, enabled: true,
        permissions: { read: lastReadable && index === 63, edit: false, shell: false, job_control: false } }));
      f.registry.mockImplementation(async request => {
        const url = new URL(request.url);
        if (url.pathname === snapshotPath) return Response.json({ ok: true, revision: 1, checksum });
        if (url.pathname === listPath) return Response.json(receipt(workspaces.filter(workspace => workspace.permissions.read)));
        // Keep the prior read routes available so the regression measures the
        // real fan-out instead of failing merely because a mock route changed.
        if (url.pathname.endsWith("/active-workspaces")) return Response.json({ workspaces });
        if (url.pathname.includes("/effective-permissions/")) return Response.json({ permissions: workspaces.find(workspace => workspace.workspace_id === url.searchParams.get("workspace_id"))?.permissions });
        throw new Error(`Unexpected test route: ${url.pathname}`);
      });
      const result = await checkAnyReadPermission(f.env, "client-test", "runner-test");
      if (lastReadable) expect(result).toBeUndefined();
      else expect(result).toMatchObject({ error: { code: "permission_denied", operation_state: "not_started" } });
      console.log(JSON.stringify({ scenario: "any_read_permission_64", last_readable: lastReadable, requests: f.registry.mock.calls.length }));
      expect(f.registry.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([snapshotPath, listPath]);
      expect(f.dispatch).not.toHaveBeenCalled();
    });

    it.each(["pending", "unavailable"] as const)("does not read workspaces after a %s snapshot", async state => {
      const f = fixture();
      f.registry.mockImplementation(async () => state === "pending" ? Response.json({ ok: false, code: "policy_pending", reason: "policy identity is not fully applied" }) : new Response(null, { status: 503 }));
      expect(await checkAnyReadPermission(f.env, "client-test", "runner-test")).toMatchObject({ error: {
        code: state === "pending" ? "policy_pending" : "registry_unavailable", operation_state: "not_started" } });
      expect(f.registry.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([snapshotPath]);
      expect(f.dispatch).not.toHaveBeenCalled();
    });

    it.each([404, 503])("preserves the effective workspace HTTP %i outcome", async status => {
      const f = fixture();
      f.registry.mockImplementation(async request => new URL(request.url).pathname === snapshotPath
        ? Response.json({ ok: true, revision: 1, checksum }) : new Response(null, { status }));
      expect(await checkAnyReadPermission(f.env, "client-test", "runner-test")).toMatchObject({ error: {
        code: status === 404 ? "permission_denied" : "registry_unavailable", operation_state: "not_started" } });
      expect(f.registry.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([snapshotPath, listPath]);
      expect(f.dispatch).not.toHaveBeenCalled();
    });

    it.each([
      null, {}, { workspaces: [] }, { ...receipt([]), workspaces: "invalid" },
      { ...receipt([]), runner_id: "another-runner" }, { ...receipt([]), revision: 0 }, { ...receipt([]), checksum: "invalid" },
      receipt([null]), receipt([{ workspace_id: "work", enabled: true, permissions: { read: "true", edit: false, shell: false, job_control: false } }]),
    ])("keeps a malformed effective workspace receipt distinct from denied permissions: %j", async value => {
      const f = fixture();
      f.registry.mockImplementation(async request => Response.json(new URL(request.url).pathname === snapshotPath ? { ok: true, revision: 1, checksum } : value));
      expect(await checkAnyReadPermission(f.env, "client-test", "runner-test")).toMatchObject({ error: { code: "authorization_response_invalid", operation_state: "not_started" } });
      expect(f.registry.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([snapshotPath, listPath]);
      expect(f.dispatch).not.toHaveBeenCalled();
    });
  });
  it.each(["busy", "runner_offline", "path_changed", "job_history_unavailable"])("keeps %s metadata in text-only clients", code => {
    const result = failure(code, "Safe message", hintFor(code));
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });
  it("keeps Worker receipts while redacting private fields", () => {
    const result = runnerFailure({ code: "tool_result_invalid", message: "Bad reply", hint: "Inspect the original Job", ...failureMetadata("tool_result_invalid"),
      details: { job_id: "job-original", workspace_id: "work", token: "secret", cwd: "/private" } }, selection) as ReturnType<typeof failureWithDetails>;
    expect(result.structuredContent).toMatchObject({ error: { operation_state: "unknown", details: { job_id: "job-original", workspace_id: "work" } } });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(JSON.stringify(result)).not.toMatch(/secret|\/private/);
  });
  it.each(["get", "logs", "cancel"] as const)("explains missing cloud history for job.%s without dispatching or switching runners", async action => {
    const f = fixture();
    const result = await jobTool(f.env, "client-test", { action, job_id: "job-original" }, ["coding:read", "coding:exec"]);
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "job_history_unavailable", operation_state: "not_started", details: { job_id: "job-original" },
      recovery_hint: expect.stringContaining("workspace_id") } } });
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.registry.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  });
  it.each(["get", "cancel", "input"] as const)("does not label a mismatched job.%s reply as an unstarted permission failure", async action => {
    const f = fixture(() => Response.json({ type: "rpc.response", result: { job_id: "job-other", workspace_id: "private-workspace", status: "running", accepted: 1 } }));
    const input = action === "input" ? { action, job_id: "job-original", workspace_id: "work", data: "x" } : { action, job_id: "job-original", workspace_id: "work" };
    const result = await jobTool(f.env, "client-test", input, ["coding:read", "coding:exec"]);
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "tool_result_invalid", operation_state: "unknown", details: { job_id: "job-original", workspace_id: "work" } } } });
    expect(JSON.stringify(result)).not.toMatch(/job-other|private-workspace/);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
});


describe("bounded control-plane observations", () => {
  it.each(["read", "mutation", "authorization"] as const)("rejects an oversized %s receipt", async kind => {
    const f = fixture();
    const value = { ok: true, padding: "x".repeat(kind === "read" ? 1_048_576 : 16_384) };
    f.registry.mockImplementation(async () => Response.json(value));
    const result = kind === "read" ? await registryCall(f.env, "/snapshot")
      : kind === "mutation" ? await registryPostCall(f.env, "/mutation", {}) : await invoke(f.env);
    expect(result).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: kind === "mutation" ? "unknown" : "not_started" } });
    expect(f.registry).toHaveBeenCalledTimes(1);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each(["read", "mutation", "authorization"] as const)("does not trust an expired %s receipt", async kind => {
    const f = fixture(), now = vi.spyOn(performance, "now").mockReturnValue(0);
    f.registry.mockImplementation(async () => { now.mockReturnValue(5001); return Response.json({ ok: true }); });
    try {
      const result = kind === "read" ? await registryCall(f.env, "/snapshot")
        : kind === "mutation" ? await registryPostCall(f.env, "/mutation", {}) : await invoke(f.env);
      expect(result).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: kind === "mutation" ? "unknown" : "not_started" } });
      expect(f.registry).toHaveBeenCalledTimes(1);
      expect(f.dispatch).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });
  it("rejects malformed UTF-8 rather than authorizing a repaired body", async () => {
    const f = fixture(), encoder = new TextEncoder();
    const bytes = new Uint8Array([...encoder.encode('{"ok":true,"note":"'), 255, ...encoder.encode('"}')]);
    f.registry.mockImplementation(async () => new Response(bytes));
    expect(await invoke(f.env)).toMatchObject({ ok: false, error: { code: "registry_unavailable", operation_state: "not_started" } });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("does not confirm an oversized Runner completion and does not replay it", async () => {
    const f = fixture(() => Response.json({ type: "rpc.response", result: { padding: "x".repeat(1_048_576) } }));
    expect(await invoke(f.env)).toMatchObject({ ok: false, error: { code: "runner_rpc_failed", operation_state: "unknown" } });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("Registry Job identity binding", () => {
  it.each(["online", "offline"] as const)("does not return another Job from a %s snapshot", async state => {
    const f = fixture(), original = f.registry.getMockImplementation()!;
    f.registry.mockImplementation(async request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/active-runner")) return Response.json({ active_runner_id: "runner-test", active_runner_updated_at_ms: 1,
        runner: { ...selection.context, state, available: state === "online" } });
      if (path.includes("/jobs/")) return Response.json({ job_id: "job-other", workspace_id: "work", status: "running" });
      return original(request);
    });
    const result = await jobTool(f.env, "client-test", { action: "get", job_id: "job-original" }, ["coding:read"]);
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: "registry_unavailable", operation_state: "not_started" } } });
    expect(JSON.stringify(result)).not.toContain("job-other");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("retains a matching offline Job snapshot without dispatch", async () => {
    const f = fixture(), original = f.registry.getMockImplementation()!;
    f.registry.mockImplementation(async request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/active-runner")) return Response.json({ active_runner_id: "runner-test", active_runner_updated_at_ms: 1,
        runner: { ...selection.context, state: "offline", available: false } });
      if (path.includes("/jobs/")) return Response.json({ job_id: "job-original", workspace_id: "work", status: "running" });
      return original(request);
    });
    const result = await jobTool(f.env, "client-test", { action: "get", job_id: "job-original" }, ["coding:read"]);
    expect(result).toMatchObject({ structuredContent: { job_id: "job-original", workspace_id: "work", source: "registry_snapshot" } });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
