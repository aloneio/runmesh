import { negotiateProtocolVersion, PROTOCOL_MIN_VERSION, PROTOCOL_CURRENT_VERSION, RunnerPolicySchema, runnerPolicyChecksum, validatePermissionSet, type RunnerHello, type RunnerWelcome, type RunnerPolicy } from "@aloneio/runmesh-protocol";
import { record } from "../values.js";

/** Pure handshake decisions; socket, Registry and admission ownership stay in RunnerDO. */
export function negotiateRunnerHello(hello: RunnerHello, runnerId: string): { readonly ok: true; readonly protocolVersion: number } | { readonly ok: false; readonly code: number; readonly reason: string } {
  if (hello.runner.runner_id !== runnerId) return { ok: false, code: 1008, reason: "runner id mismatch" };
  const result = negotiateProtocolVersion(
    { min_protocol_version: PROTOCOL_MIN_VERSION, max_protocol_version: PROTOCOL_CURRENT_VERSION },
    { min_protocol_version: hello.min_protocol_version, max_protocol_version: hello.max_protocol_version },
  );
  return result.ok ? { ok: true, protocolVersion: result.protocol_version } : { ok: false, code: 1002, reason: result.error.code };
}

export interface RegistryHelloReceipt {
  readonly epoch: number;
  readonly lifecycleId: string;
  readonly contextMethods: Array<"context.storage" | "context.prune">;
  readonly queueProtocol?: 1;
  readonly historyProtocol?: 2;
  readonly extensions: RunnerWelcome["extensions"];
  readonly desiredPolicy?: NonNullable<RunnerWelcome["desired_policy"]>;
}

/** Receives decoded Registry JSON; performs no I/O or attachment mutation. */
export function parseRegistryHelloReceipt(value: unknown, hello: RunnerHello): RegistryHelloReceipt | undefined {
  const body = record(value);
  if (body === undefined || typeof body.epoch !== "number" || !Number.isSafeInteger(body.epoch) || body.epoch < 1 || !validLifecycleId(body.lifecycle_id)) return undefined;
  const capabilities = hello.runner.capabilities;
  const queueProtocol = capabilities.labels.job_queue_protocol === "1";
  const history = record(body.job_history);
  const historyProtocol = capabilities.labels.job_reporting_protocol === "2" && body.job_reporting === 2 && history !== undefined;
  return {
    epoch: body.epoch, lifecycleId: body.lifecycle_id,
    contextMethods: (["context.storage", "context.prune"] as const).filter(method => capabilities.supported_rpc_methods.includes(method)),
    ...(queueProtocol ? { queueProtocol: 1 as const } : {}),
    ...(historyProtocol ? { historyProtocol: 2 as const } : {}),
    // Registry JSON has already been decoded by the transport. Preserve the
    // negotiated extension payload for the shared wire encoder to validate.
    extensions: { ...(history === undefined ? {} : { runmesh_job_history: history as never }), ...(queueProtocol ? { runmesh_job_queue: 1 } : {}), ...(historyProtocol ? { runmesh_job_reporting: 2 } : {}) },
    ...(isRunnerPolicy(body.desired_policy) ? { desiredPolicy: body.desired_policy } : {}),
  };
}

export function runnerWelcome(receipt: RegistryHelloReceipt, input: { readonly protocolVersion: number; readonly requestId: string; readonly sessionId: string; readonly workerId: string; readonly workerVersion: string }): RunnerWelcome {
  return {
    type: "runner.welcome", protocol_version: input.protocolVersion, request_id: input.requestId,
    session_id: input.sessionId, negotiated_protocol_version: input.protocolVersion,
    extensions: receipt.extensions,
    worker: {
      worker_id: input.workerId, worker_version: input.workerVersion,
      capabilities: { filesystem: false, process_execution: false, workspace_sync: true, pty: false, network_access: false, max_concurrent_jobs: 1, supported_rpc_methods: ["echo", "runner.info"], labels: { runtime: "cloudflare" } },
    },
    ...(receipt.desiredPolicy === undefined ? {} : { desired_policy: receipt.desiredPolicy }),
  };
}

export function validLifecycleId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

export function isRunnerPolicy(value: unknown): value is RunnerPolicy {
  const parsed = RunnerPolicySchema.safeParse(value);
  if (!parsed.success || parsed.data.workspaces.length > 64 || new Set(parsed.data.workspaces.map((workspace) => workspace.workspace_id)).size !== parsed.data.workspaces.length || !validatePermissionSet(parsed.data.runner_permissions)) return false;
  const policy = parsed.data;
  if (policy.workspaces.some((workspace) => workspace.root_path.includes("\0") || !validatePermissionSet(workspace.permissions))) return false;
  return runnerPolicyChecksum({ schema_version: policy.schema_version, runner_id: policy.runner_id, revision: policy.revision, runner_permissions: policy.runner_permissions, workspaces: policy.workspaces }) === policy.checksum;
}
