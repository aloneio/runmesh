import { expect, it, vi } from "vitest";
import { authThrottleCheck, authThrottleRecord } from "../../apps/worker/src/application/auth-source.js";
import { createEnrollmentCode } from "../../apps/worker/src/application/enrollment.js";
import { verifyMcpClient } from "../../apps/worker/src/application/mcp-identity.js";
import { loadLiveJobs, policyReadiness, runnerEnvironment, runnerExecutionSnapshot } from "../../apps/worker/src/application/runner-queries.js";
import type { JsonReceipt, RunnerQueryPorts } from "../../apps/worker/src/contracts/control-plane-receipts.js";
import { appliedPolicyIdentity } from "../../apps/worker/src/contracts/runner-selection.js";

const checksum = "a".repeat(64);
const ready = { ok: true, policy_status: "applied", desired_revision: 3, applied_revision: 3, runner_reported_policy_revision: 3,
  desired_checksum: checksum, active_checksum: checksum, runner_reported_policy_checksum: checksum };
function queries(receipt: JsonReceipt = { status: 200, value: ready }) {
  return { execution: vi.fn(async () => ({ status: 200, value: { runner: { runner_id: "runner-1", configured_execution_mode: "dedicated_user" }, lifecycle_id: "lifecycle-1" } })),
    readiness: vi.fn(async () => receipt), rpc: vi.fn(async () => ({ status: 200, value: { result: {} } })) } satisfies RunnerQueryPorts;
}

it.each([undefined, "pending", "offline_pending", "invalid"])("requires applied policy state %s consistently and does not query a Runner", async policy_status => {
  const value = { ...ready, policy_status }, ports = queries({ status: 200, value });
  expect(appliedPolicyIdentity(value)).toBeUndefined();
  expect(await policyReadiness(ports, "runner-1")).toEqual({ ok: false });
  expect(await runnerEnvironment(ports, "runner-1")).toBeUndefined();
  expect(await loadLiveJobs(ports, "runner-1", "work", 10)).toBeUndefined();
  expect(ports.rpc).not.toHaveBeenCalled();
});
it.each([{ desired_revision: 2 }, { runner_reported_policy_revision: 2 }, { active_checksum: "b".repeat(64) }, { applied_revision: 0 }, { applied_revision: 1.5 }, { active_checksum: "invalid" }])("rejects inconsistent policy evidence %j", change => {
  expect(appliedPolicyIdentity({ ...ready, ...change })).toBeUndefined();
});
it("accepts matching policy identity without copying unrelated fields", () => {
  expect(appliedPolicyIdentity({ ...ready, extra: "private" })).toEqual({ applied_revision: 3, active_checksum: checksum });
});
it("reads Runner mode and lifecycle in a single query", async () => {
  const ports = queries();
  expect(await runnerExecutionSnapshot(ports, "runner-1")).toMatchObject({ status: 200, snapshot: { configuredMode: "dedicated_user", lifecycleId: "lifecycle-1" } });
  expect(ports.execution).toHaveBeenCalledExactlyOnceWith("runner-1");
  expect(ports.readiness).not.toHaveBeenCalled();
  expect(await runnerExecutionSnapshot(ports, "runner-other")).toEqual({ status: 502 });
});
it("queries live Jobs with the verified policy and rejects another workspace's Jobs", async () => {
  const ports = queries();
  ports.rpc.mockResolvedValue({ status: 200, value: { result: { jobs: [{ workspace_id: "work", job_id: "j1" }, { workspace_id: "other", job_id: "j2" }] } } });
  expect(await loadLiveJobs(ports, "runner-1", "work", 10)).toBeUndefined();
  expect(ports.rpc).toHaveBeenCalledExactlyOnceWith("runner-1", "job.list", { workspace_id: "work", limit: 10 }, 3, checksum);
  ports.rpc.mockResolvedValue({ status: 200, value: { result: { jobs: [{ workspace_id: "work", job_id: "j1" }] } } });
  expect(await loadLiveJobs(ports, "runner-1", "work", 10)).toEqual([{ workspace_id: "work", job_id: "j1" }]);
});
it.each([201, 202, 206, 503])("does not use an incomplete readiness response %s", async status => {
  const ports = queries({ status, value: ready });
  expect(await runnerEnvironment(ports, "runner-1")).toBeUndefined();
  expect(ports.rpc).not.toHaveBeenCalled();
});
it("matches enrollment receipts through injected generation and persistence", async () => {
  const create = vi.fn(async (_id: string, payload: Record<string, unknown>) => ({ status: 200, value: { runner_id: "runner-1", enrollment_id: payload.enrollment_id, created_at_ms: 10, not_before_ms: 10, expires_at_ms: 20 } }));
  const ports = { randomCode: vi.fn().mockReturnValueOnce("secret-code").mockReturnValueOnce("enrollment-id"), digest: vi.fn(async () => "hashed-code"), create };
  expect(await createEnrollmentCode(ports, "runner-1")).toEqual({ ok: true, code: "secret-code", created_at_ms: 10, not_before_ms: 10, expires_at_ms: 20 });
  expect(create.mock.calls[0]?.[1]).toMatchObject({ enrollment_id: "enrollment-id", verifier: "hashed-code" });
  expect(JSON.stringify(create.mock.calls)).not.toContain("secret-code");
});
it("accepts a current MCP identity using only a verification port", async () => {
  const verify = vi.fn(async () => ({ status: 200, value: { schema_version: 2, client_id: "client-1", label: "Test", secret_version: 1, native_scopes: [] } }));
  expect(await verifyMcpClient(verify, "verifier")).toEqual({ client_id: "client-1", label: "Test", secret_version: 1, scopes: [] });
  expect(verify).toHaveBeenCalledExactlyOnceWith("verifier");
});
it("requires a completed throttle decision but keeps recording failures advisory", async () => {
  const ports = { check: vi.fn(async () => ({ status: 202, value: { allowed: true, retry_after_ms: 0 } })), record: vi.fn(async () => { throw new Error("unavailable"); }) };
  expect(await authThrottleCheck(ports, "login")).toBeUndefined();
  await expect(authThrottleRecord(ports, "login", true)).resolves.toBeUndefined();
});
