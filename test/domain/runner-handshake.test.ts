import { expect, it } from "vitest";
import { PROTOCOL_CURRENT_VERSION, PROTOCOL_MIN_VERSION, encodeWireFrame, decodeWireFrame, policyWithoutChecksum, runnerPolicyChecksum, type RunnerHello, type RunnerPolicy } from "@aloneio/runmesh-protocol";
import { isRunnerPolicy, negotiateRunnerHello, parseRegistryHelloReceipt, runnerWelcome } from "../../apps/worker/src/domain/runner-handshake.js";

function hello(labels: Record<string, string> = {}): RunnerHello {
  return {
    type: "runner.hello", protocol_version: PROTOCOL_CURRENT_VERSION, request_id: "hello-1",
    min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION,
    runner: { runner_id: "runner-1", runner_version: "test", platform: "test", architecture: "test",
      capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1,
        supported_rpc_methods: ["context.storage", "echo", "context.storage", "context.prune", "context.unsupported"], labels } },
  };
}
const identity = { epoch: 7, lifecycle_id: "lifecycle-123456789" };
const worker = { protocolVersion: PROTOCOL_CURRENT_VERSION, requestId: "hello-1", sessionId: "session-1", workerId: "worker-1", workerVersion: "test" };
function policy(): RunnerPolicy {
  const value = { schema_version: 1 as const, runner_id: "runner-1", revision: 3,
    runner_permissions: { read: true, edit: false, shell: false, job_control: false },
    workspaces: [{ workspace_id: "workspace-1", root_path: "/workspace", enabled: true, permissions: { read: true, edit: false, shell: false, job_control: false } }] };
  return { ...value, checksum: runnerPolicyChecksum(value) };
}

it("negotiates the protocol and preserves identity/protocol close outcomes", () => {
  expect(negotiateRunnerHello(hello(), "runner-1")).toEqual({ ok: true, protocolVersion: PROTOCOL_CURRENT_VERSION });
  expect(negotiateRunnerHello(hello(), "another-runner")).toEqual({ ok: false, code: 1008, reason: "runner id mismatch" });
  expect(negotiateRunnerHello({ ...hello(), min_protocol_version: PROTOCOL_CURRENT_VERSION + 1, max_protocol_version: PROTOCOL_CURRENT_VERSION + 2 }, "runner-1"))
    .toMatchObject({ ok: false, code: 1002, reason: expect.any(String) });
});

it.each([null, [], "invalid", {}, { ...identity, epoch: 0 }, { ...identity, epoch: -1 }, { ...identity, epoch: 1.5 },
  { ...identity, epoch: Number.MAX_SAFE_INTEGER + 1 }, { ...identity, epoch: "7" }, { ...identity, lifecycle_id: null },
  { ...identity, lifecycle_id: "short" }, { ...identity, lifecycle_id: "a".repeat(129) }, { ...identity, lifecycle_id: "invalid lifecycle id" }])
  ("rejects malformed Registry identity %#", value => {
    expect(parseRegistryHelloReceipt(value, hello())).toBeUndefined();
  });

it("projects only bounded context capabilities and leaves the inputs unchanged", () => {
  const message = hello();
  const before = JSON.stringify(message);
  const receipt = parseRegistryHelloReceipt(Object.freeze({ ...identity }), message)!;
  expect(receipt).toEqual({ epoch: 7, lifecycleId: identity.lifecycle_id, contextMethods: ["context.storage", "context.prune"], extensions: {} });
  expect(JSON.stringify(message)).toBe(before);
});

it.each([
  [{}, 2, {}, false, false],
  [{ job_queue_protocol: "1" }, 2, {}, true, false],
  [{ job_queue_protocol: "2", job_reporting_protocol: "1" }, 2, {}, false, false],
  [{ job_reporting_protocol: "2" }, 1, {}, false, false],
  [{ job_reporting_protocol: "2" }, "2", {}, false, false],
  [{ job_reporting_protocol: "2" }, 2, null, false, false],
  [{ job_reporting_protocol: "2" }, 2, [], false, false],
  [{ job_reporting_protocol: "2" }, 2, {}, false, true],
  [{ job_queue_protocol: "1", job_reporting_protocol: "2" }, 2, {}, true, true],
] as const)("projects negotiated extensions without inferring unsupported protocols %#", (labels, reporting, history, queue, reportingV2) => {
  const receipt = parseRegistryHelloReceipt({ ...identity, job_reporting: reporting, job_history: history }, hello(labels))!;
  expect(receipt.queueProtocol).toBe(queue ? 1 : undefined);
  expect(receipt.historyProtocol).toBe(reportingV2 ? 2 : undefined);
  const welcome = runnerWelcome(receipt, worker);
  expect(welcome.extensions?.runmesh_job_queue).toBe(queue ? 1 : undefined);
  expect(welcome.extensions?.runmesh_job_reporting).toBe(reportingV2 ? 2 : undefined);
  expect(welcome.extensions?.runmesh_job_history).toEqual(history !== null && !Array.isArray(history) ? history : undefined);
  expect(decodeWireFrame(encodeWireFrame(welcome))).toEqual(welcome);
});

it("preserves a valid desired policy and omits malformed policy evidence", () => {
  const desired = policy();
  const receipt = parseRegistryHelloReceipt({ ...identity, desired_policy: desired }, hello())!;
  expect(runnerWelcome(receipt, worker)).toMatchObject({ type: "runner.welcome", protocol_version: worker.protocolVersion, session_id: worker.sessionId,
    negotiated_protocol_version: worker.protocolVersion, desired_policy: desired,
    worker: { worker_id: worker.workerId, worker_version: worker.workerVersion,
      capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false,
        max_concurrent_jobs: 1, supported_rpc_methods: ["echo", "runner.info"], labels: { runtime: "cloudflare" } } } });
  expect(decodeWireFrame(encodeWireFrame(runnerWelcome(receipt, worker)))).toEqual(runnerWelcome(receipt, worker));
  const invalidFields: RunnerPolicy[] = [
    { ...desired, workspaces: [...desired.workspaces, ...desired.workspaces] },
    { ...desired, workspaces: [{ ...desired.workspaces[0]!, root_path: "/workspace\0" }] },
    { ...desired, runner_permissions: { read: false, edit: true, shell: false, job_control: false } },
    { ...desired, workspaces: Array.from({ length: 65 }, (_, index) => ({ ...desired.workspaces[0]!, workspace_id: "workspace-" + index })) },
  ];
  // Valid checksums isolate field/permission validation from checksum validation.
  for (const invalid of [null, {}, { ...desired, checksum: "0".repeat(64) },
    ...invalidFields.map(value => ({ ...value, checksum: runnerPolicyChecksum(policyWithoutChecksum(value)) }))]) {
    expect(isRunnerPolicy(invalid)).toBe(false);
    expect(runnerWelcome(parseRegistryHelloReceipt({ ...identity, desired_policy: invalid }, hello())!, worker)).not.toHaveProperty("desired_policy");
  }
});
