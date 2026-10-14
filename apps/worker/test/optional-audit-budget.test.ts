import { expect, it, vi } from "vitest";
import { recordRunnerToolCall, withAuditReceipt } from "../src/mcp/audit.js";
import type { McpRequestEnv } from "../src/mcp/contracts.js";

const checksum = "a".repeat(64);
const readiness = { ok: true, policy_status: "applied", desired_revision: 1, applied_revision: 1, runner_reported_policy_revision: 1,
  desired_checksum: checksum, active_checksum: checksum, runner_reported_policy_checksum: checksum,
  connection_epoch: 1, credential_version: 1, lifecycle_id: checksum, session_id: "audit-session" } as const;
const result = { structuredContent: { path: "example.txt", data: "verified-result" }, content: [{ type: "text", text: "verified-result" }] };
const input = () => ({ runnerId: "audit-runner", clientId: "audit-client", method: "fs.read", params: {}, result, startedAtMs: Date.now(), readiness });
function fixture(fetch: (request: Request) => Promise<Response>) {
  return { INTERNAL_CONTROL_SECRET: "test-internal-control-secret-not-for-production",
    REGISTRY: { idFromName: (name: string) => name, get: () => ({ fetch }) } } as unknown as McpRequestEnv;
}

it("bounds a stalled optional audit without retrying or replacing a verified result", async () => {
  const fetch = vi.fn((_request: Request) => new Promise<Response>(() => {}));
  const started = performance.now();
  const receipt = await recordRunnerToolCall(fixture(fetch), input());
  expect(performance.now() - started).toBeLessThan(2500);
  expect(fetch).toHaveBeenCalledOnce();
  expect(receipt).toMatchObject({ audit_status: "unknown" });
  expect(withAuditReceipt(result, receipt)).toMatchObject({ structuredContent: { data: "verified-result", audit_status: "unknown" } });
});

it("contains pre-request diagnostic failures within the optional audit boundary", async () => {
  const fetch = vi.fn(async () => Response.json({ audit_status: "recorded" }));
  const env = { ...fixture(fetch), mcpDiagnostic: { dependency: () => { throw new Error("synthetic diagnostic fault"); } } } as unknown as McpRequestEnv;
  const receipt = await recordRunnerToolCall(env, input());
  expect(receipt.audit_status).toBe("unknown"); expect(fetch).not.toHaveBeenCalled();
  expect(withAuditReceipt(result, receipt)).toMatchObject({ structuredContent: { data: "verified-result" } });
});

it.each([503, 202])("never claims audit success for an unavailable or malformed receipt %s", async status => {
  const fetch = vi.fn(async () => Response.json({ audit_status: "recorded" }, { status }));
  expect((await recordRunnerToolCall(fixture(fetch), input())).audit_status).toBe("unknown");
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(["job.get", "job.logs", "job.list"])("does not add history writes while observing %s", async method => {
  const fetch = vi.fn(async () => Response.json({ audit_status: "recorded" }));
  expect((await recordRunnerToolCall(fixture(fetch), { ...input(), method })).audit_status).toBe("disabled");
  expect(fetch).not.toHaveBeenCalled();
});
