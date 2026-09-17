import { describe, expect, it, vi } from "vitest";
import { failureMetadata, isKnownRpcFailureCode, RPC_FAILURE_CODES, PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { callRunner } from "../src/mcp/transport.js";
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
    if (path.endsWith("/policy-readiness")) return Response.json({ ok: true, desired_revision: 1, applied_revision: 1, runner_reported_policy_revision: 1,
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
  it("keeps lost replies ambiguous and never replays the command", async () => {
    const f = fixture();
    f.dispatch.mockRejectedValueOnce(new Error("connection reset"));
    const result = await invoke(f.env);
    expect(result).toMatchObject({ ok: false, error: { code: "runner_offline", operation_state: "unknown", next_action: "inspect_job" } });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("agent-visible recovery receipts", () => {
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
  it("keeps a permission dependency outage visible while scanning readable workspaces", async () => {
    const f = fixture();
    f.registry.mockImplementation(async request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/snapshot-authorization")) return Response.json({ ok: true });
      if (path.endsWith("/active-workspaces")) return Response.json({ workspaces: [{ workspace_id: "work", enabled: true }] });
      return new Response(null, { status: 503 });
    });
    expect(await checkAnyReadPermission(f.env, "client-test", "runner-test")).toMatchObject({ error: { code: "registry_unavailable", operation_state: "not_started" } });
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
