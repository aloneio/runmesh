import { z } from "zod";

/**
 * A protocol version is a wire-format major version. New optional fields and
 * capabilities are added without changing it; incompatible wire changes use a
 * new major version.
 */
export const PROTOCOL_MIN_VERSION = 2;
export const PROTOCOL_CURRENT_VERSION = 2;
export const MAX_FRAME_BYTES = 1_048_576;
/** Maximum duration for normal synchronous Runner operations such as exec.run and Git. */
export const LOCAL_RUNNER_OPERATION_TIMEOUT_MS = 8_000;
/** Worker→Runner bridge timeout; reserves a reply margin above the Runner cap. */
export const WORKER_BRIDGE_TIMEOUT_MS = 12_000;
/** Nested JSON parameters/results are bounded to make validation safe for hostile frames. */
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 10_000;

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "must be a safe identifier");
const ShortTextSchema = z.string().min(1).max(4_096);
const TimestampSchema = z.number().int().nonnegative();

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * JSON-safe values permitted in RPC parameters and results.
 *
 * Zod's recursive lazy schemas are convenient but can exhaust the JavaScript
 * stack on a deliberately deep frame. This iterative validator has fixed
 * depth/node limits and rejects values JSON.stringify would silently alter.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.any().superRefine(
  (value, context) => {
    type Pending = { readonly value: unknown; readonly depth: number };
    const pending: Pending[] = [{ value, depth: 0 }];
    const seen = new WeakSet<object>();
    let nodes = 0;

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) {
        break;
      }
      nodes += 1;
      if (nodes > MAX_JSON_NODES) {
        context.addIssue({ code: "custom", message: "JSON value has too many nodes" });
        return;
      }
      if (current.depth > MAX_JSON_DEPTH) {
        context.addIssue({ code: "custom", message: "JSON value is nested too deeply" });
        return;
      }

      const currentType = typeof current.value;
      if (
        current.value === null ||
        currentType === "boolean" ||
        currentType === "string"
      ) {
        continue;
      }
      if (currentType === "number") {
        if (!Number.isFinite(current.value)) {
          context.addIssue({ code: "custom", message: "JSON numbers must be finite" });
          return;
        }
        continue;
      }
      if (currentType !== "object" || current.value === null) {
        context.addIssue({ code: "custom", message: "Value is not JSON-safe" });
        return;
      }
      const objectValue = current.value as object;
      if (seen.has(objectValue)) {
        context.addIssue({ code: "custom", message: "JSON values cannot contain cycles" });
        return;
      }
      seen.add(objectValue);

      if (Array.isArray(objectValue)) {
        for (const item of objectValue) {
          pending.push({ value: item, depth: current.depth + 1 });
        }
        continue;
      }
      if (Object.getPrototypeOf(objectValue) !== Object.prototype) {
        context.addIssue({ code: "custom", message: "JSON objects must be plain objects" });
        return;
      }
      for (const descriptor of Object.values(
        Object.getOwnPropertyDescriptors(objectValue),
      )) {
        if (!("value" in descriptor)) {
          context.addIssue({ code: "custom", message: "JSON objects cannot contain accessors" });
          return;
        }
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }
  },
);

export const ProtocolVersionSchema = z.number().int().positive();
const ExtensionsSchema = z.record(z.string().min(1).max(128), JsonValueSchema);
export const ProtocolVersionRangeSchema = z
  .object({
    min_protocol_version: ProtocolVersionSchema,
    max_protocol_version: ProtocolVersionSchema,
  })
  .strict()
  .refine(
    ({ min_protocol_version, max_protocol_version }) =>
      min_protocol_version <= max_protocol_version,
    "min_protocol_version must not exceed max_protocol_version",
  );

export const CapabilityMetadataSchema = z
  .object({
    filesystem: z.boolean(),
    process_execution: z.boolean(),
    workspace_sync: z.boolean(),
    pty: z.boolean(),
    network_access: z.boolean(),
    max_concurrent_jobs: z.number().int().positive(),
    supported_rpc_methods: z.array(ShortTextSchema).max(256),
    labels: z.record(z.string().min(1).max(128), z.string().max(512)),
  })
  .strict();

export const RunnerMetadataSchema = z
  .object({
    runner_id: IdentifierSchema,
    runner_version: ShortTextSchema,
    platform: ShortTextSchema,
    architecture: ShortTextSchema,
    capabilities: CapabilityMetadataSchema,
  })
  .strict();

export const WorkerMetadataSchema = z
  .object({
    worker_id: IdentifierSchema,
    worker_version: ShortTextSchema,
    capabilities: CapabilityMetadataSchema,
  })
  .strict();

export const WorkspaceMetadataSchema = z
  .object({
    workspace_id: IdentifierSchema,
    /**
     * Workspace roots are local authorization boundaries. They are never sent
     * in metadata or public responses; policy delivery uses a separate,
     * authenticated Runner-only message.
     */
    persistence: z.enum(["persistent", "ephemeral"]),
    revision: z.string().max(512).optional(),
    labels: z.record(z.string().min(1).max(128), z.string().max(512)),
  })
  .strict();

/** Bounded permission bits shared by central policy and the Runner enforcement point. */
export const PermissionSetSchema = z.object({
  read: z.boolean(),
  edit: z.boolean(),
  shell: z.boolean(),
  job_control: z.boolean(),
}).strict();

/**
 * This is intentionally a configuration contract, not WorkspaceMetadata. Root
 * paths are permitted only on this authenticated Runner connection and are
 * never reflected into public/MCP metadata.
 */
export const RunnerPolicyWorkspaceSchema = z.object({
  workspace_id: IdentifierSchema,
  root_path: z.string().min(1).max(4_096).refine((value) => !value.includes("\0"), "root_path must not contain NUL"),
  enabled: z.boolean(),
  permissions: PermissionSetSchema,
}).strict();

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
  "unknown",
  "interrupted",
]);

export const JobMetadataSchema = z
  .object({
    job_id: IdentifierSchema,
    workspace_id: IdentifierSchema,
    status: JobStatusSchema,
    created_at_ms: TimestampSchema,
    updated_at_ms: TimestampSchema,
    display_name: z.string().min(1).max(512).optional(),
    created_by_client_id: IdentifierSchema.optional(),
    runner_id: IdentifierSchema.optional(),
  })
  .strict();

const EnvelopeSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    extensions: ExtensionsSchema.optional(),
  })
  .strict();

const CorrelatedEnvelopeSchema = EnvelopeSchema.extend({
  request_id: IdentifierSchema,
}).strict();

export const ProtectedRpcMethodSchema = z.enum([
  "env.info", "workspace.list", "fs.stat", "fs.read", "fs.list", "fs.search", "fs.apply_patch", "fs.patch",
  "git.status", "git.diff", "exec.start", "exec.run", "job.list", "job.get", "job.logs", "job.cancel", "job.input",
]);
export type ProtectedRpcMethod = z.infer<typeof ProtectedRpcMethodSchema>;
/** Unknown methods are protected by default; only echo and runner.info are unprotected. */
export function isProtectedRpcMethod(method: string): boolean {
  return method !== "echo" && method !== "runner.info";
}

/**
 * Authenticated control-plane policy delivered only to a Runner. Root paths
 * never appear in public metadata or MCP responses.
 */
export const RunnerPolicySchema = z.object({
  schema_version: z.literal(1),
  runner_id: IdentifierSchema,
  revision: z.number().int().positive().refine(Number.isSafeInteger),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  runner_permissions: PermissionSetSchema,
  workspaces: z.array(RunnerPolicyWorkspaceSchema).max(64),
}).strict();

export const RunnerPolicyUpdateSchema = CorrelatedEnvelopeSchema.extend({
  type: z.literal("runner.policy_update"),
  runner_id: IdentifierSchema,
  policy: RunnerPolicySchema,
}).strict();

export const RunnerHelloSchema = CorrelatedEnvelopeSchema.extend({
  type: z.literal("runner.hello"),
  runner: RunnerMetadataSchema,
  min_protocol_version: ProtocolVersionSchema,
  max_protocol_version: ProtocolVersionSchema,
})
  .strict()
  .refine(
    ({ min_protocol_version, max_protocol_version }) =>
      min_protocol_version <= max_protocol_version,
    "min_protocol_version must not exceed max_protocol_version",
  );

export const RunnerWelcomeSchema = CorrelatedEnvelopeSchema.extend({
  type: z.literal("runner.welcome"),
  worker: WorkerMetadataSchema,
  session_id: IdentifierSchema,
  negotiated_protocol_version: ProtocolVersionSchema,
  /** Authenticated central desired policy for the negotiated v2 session. */
  desired_policy: RunnerPolicySchema.optional(),
}).strict();

const NullablePolicyRevisionSchema = z.number().int().positive().refine(Number.isSafeInteger).nullable();
const NullablePolicyChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/).nullable();

export const RunnerPolicyAckSchema = EnvelopeSchema.extend({
  type: z.literal("runner.policy_ack"),
  runner_id: IdentifierSchema,
  desired_revision: z.number().int().positive().refine(Number.isSafeInteger),
  desired_checksum: z.string().regex(/^[a-f0-9]{64}$/),
  /** Runner-local active policy after applying (or retaining) the desired candidate. */
  applied_revision: NullablePolicyRevisionSchema,
  applied_checksum: NullablePolicyChecksumSchema,
  /** Explicitly reported active identity; RunnerDO must forward it without deriving it. */
  runner_reported_policy_revision: NullablePolicyRevisionSchema,
  runner_reported_policy_checksum: NullablePolicyChecksumSchema,
  status: z.enum(["applied", "pending", "invalid"]),
  /** Per-workspace non-sensitive validation status; roots are never echoed. */
  workspace_status: z.array(z.object({
    workspace_id: IdentifierSchema,
    status: z.enum(["valid", "missing", "not_directory", "permission_denied", "invalid_path"]),
  }).strict()).max(64),
}).strict().superRefine((value, context) => {
  const appliedPair = (value.applied_revision === null) === (value.applied_checksum === null);
  const reportedPair = (value.runner_reported_policy_revision === null) === (value.runner_reported_policy_checksum === null);
  if (!appliedPair) context.addIssue({ code: "custom", path: ["applied_revision"], message: "applied revision and checksum must both be null or both be present" });
  if (!reportedPair) context.addIssue({ code: "custom", path: ["runner_reported_policy_revision"], message: "reported revision and checksum must both be null or both be present" });
  if (value.applied_revision !== value.runner_reported_policy_revision || value.applied_checksum !== value.runner_reported_policy_checksum) {
    context.addIssue({ code: "custom", message: "reported policy identity must equal the Runner active policy identity" });
  }
  if (value.status === "applied" && (value.applied_revision !== value.desired_revision || value.applied_checksum !== value.desired_checksum)) {
    context.addIssue({ code: "custom", message: "applied acknowledgement must match the desired policy" });
  }
});

export const RunnerHeartbeatSchema = EnvelopeSchema.extend({
  type: z.literal("runner.heartbeat"),
  runner_id: IdentifierSchema,
  sent_at_ms: TimestampSchema,
  active_job_ids: z.array(IdentifierSchema).max(10_000),
}).strict();

export const RunnerSyncSchema = EnvelopeSchema.extend({
  type: z.literal("runner.sync"),
  runner_id: IdentifierSchema,
  sync_sequence: z.number().int().nonnegative(),
  sent_at_ms: TimestampSchema,
  workspaces: z.array(WorkspaceMetadataSchema).max(10_000),
  jobs: z.array(JobMetadataSchema).max(10_000),
}).strict();

export const RpcRequestSchema = CorrelatedEnvelopeSchema.extend({
  type: z.literal("rpc.request"),
  method: ShortTextSchema,
  params: JsonValueSchema,
  policy_revision: z.number().int().positive().refine(Number.isSafeInteger).optional(),
  workspace: WorkspaceMetadataSchema.optional(),
  job: JobMetadataSchema.optional(),
}).strict().superRefine((value, context) => {
  if (isProtectedRpcMethod(value.method) && value.policy_revision === undefined) {
    context.addIssue({ code: "custom", path: ["policy_revision"], message: "protected RPC methods require a positive policy_revision" });
  }
});

export const RpcResponseSchema = CorrelatedEnvelopeSchema.extend({
  type: z.literal("rpc.response"),
  result: JsonValueSchema,
}).strict();

export const RpcErrorDetailsSchema = z
  .object({
    code: z.string().min(1).max(128),
    message: ShortTextSchema,
    details: JsonValueSchema.optional(),
  })
  .strict();

export const RpcErrorSchema = CorrelatedEnvelopeSchema.extend({
  type: z.literal("rpc.error"),
  error: RpcErrorDetailsSchema,
}).strict();

export const JobStartedSchema = CorrelatedEnvelopeSchema.extend({
  type: z.literal("job.started"),
  job: JobMetadataSchema,
  workspace: WorkspaceMetadataSchema,
  started_at_ms: TimestampSchema,
}).strict();

export const JobOutputSchema = CorrelatedEnvelopeSchema.extend({
  type: z.literal("job.output"),
  job_id: IdentifierSchema,
  workspace_id: IdentifierSchema,
  sequence: z.number().int().nonnegative(),
  stream: z.enum(["stdout", "stderr"]),
  encoding: z.literal("utf-8"),
  data: z.string(),
}).strict();

export const JobStatusMessageSchema = CorrelatedEnvelopeSchema.extend({
  type: z.literal("job.status"),
  job: JobMetadataSchema,
}).strict();

export const JobCompletedSchema = CorrelatedEnvelopeSchema.extend({
  type: z.literal("job.completed"),
  job: JobMetadataSchema,
  completed_at_ms: TimestampSchema,
  outcome: z.enum(["succeeded", "failed", "cancelled"]),
  exit_code: z.number().int().min(-1).max(255).nullable(),
  error: RpcErrorDetailsSchema.optional(),
}).strict().superRefine(({ job, outcome, exit_code, error }, context) => {
  if (job.status !== outcome) context.addIssue({ code: "custom", path: ["job", "status"], message: "completed job status must equal outcome" });
  if (outcome === "succeeded" && (exit_code === null || exit_code !== 0 || error !== undefined)) {
    context.addIssue({ code: "custom", message: "successful jobs require exit_code 0 and no error" });
  }
  if (outcome === "cancelled" && exit_code !== null) {
    context.addIssue({ code: "custom", path: ["exit_code"], message: "cancelled jobs require a null exit_code" });
  }
});

/** The complete, closed set of valid Runner <-> Worker wire messages. */
export const WireMessageSchema = z.discriminatedUnion("type", [
  RunnerHelloSchema,
  RunnerWelcomeSchema,
  RunnerPolicyUpdateSchema,
  RunnerPolicyAckSchema,
  RunnerHeartbeatSchema,
  RunnerSyncSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  RpcErrorSchema,
  JobStartedSchema,
  JobOutputSchema,
  JobStatusMessageSchema,
  JobCompletedSchema,
]);

export type PermissionSet = z.infer<typeof PermissionSetSchema>;
export type RunnerPolicyWorkspace = z.infer<typeof RunnerPolicyWorkspaceSchema>;
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;
export type ProtocolVersionRange = z.infer<typeof ProtocolVersionRangeSchema>;
export type CapabilityMetadata = z.infer<typeof CapabilityMetadataSchema>;
export type RunnerMetadata = z.infer<typeof RunnerMetadataSchema>;
export type WorkerMetadata = z.infer<typeof WorkerMetadataSchema>;
export type WorkspaceMetadata = z.infer<typeof WorkspaceMetadataSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobMetadata = z.infer<typeof JobMetadataSchema>;
export type RunnerHello = z.infer<typeof RunnerHelloSchema>;
export type RunnerWelcome = z.infer<typeof RunnerWelcomeSchema>;
export type RunnerPolicy = z.infer<typeof RunnerPolicySchema>;
export type RunnerPolicyUpdate = z.infer<typeof RunnerPolicyUpdateSchema>;
export type RunnerPolicyAck = z.infer<typeof RunnerPolicyAckSchema>;
export type RunnerHeartbeat = z.infer<typeof RunnerHeartbeatSchema>;
export type RunnerSync = z.infer<typeof RunnerSyncSchema>;
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
export type RpcError = z.infer<typeof RpcErrorSchema>;
export type JobStarted = z.infer<typeof JobStartedSchema>;
export type JobOutput = z.infer<typeof JobOutputSchema>;
export type JobStatusMessage = z.infer<typeof JobStatusMessageSchema>;
export type JobCompleted = z.infer<typeof JobCompletedSchema>;
export type WireMessage = z.infer<typeof WireMessageSchema>;
