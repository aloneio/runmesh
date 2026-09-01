import {
  MAX_FRAME_BYTES,
  LOCAL_RUNNER_OPERATION_TIMEOUT_MS,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  PROTOCOL_CURRENT_VERSION,
  PROTOCOL_MIN_VERSION,
  ProtocolVersionRangeSchema,
  WireMessageSchema,
  WORKER_BRIDGE_TIMEOUT_MS,
  type ProtocolVersion,
  type ProtocolVersionRange,
  type WireMessage,
} from "./schema.js";

export {
  CapabilityMetadataSchema,
  JobCompletedSchema,
  JobMetadataSchema,
  JobOutputSchema,
  JobStartedSchema,
  JobStatusMessageSchema,
  JobStatusSchema,
  IdentifierSchema,
  JsonValueSchema,
  PermissionSetSchema,
  ProtocolVersionRangeSchema,
  ProtocolVersionSchema,
  RpcErrorDetailsSchema,
  RpcErrorSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  RunnerHeartbeatSchema,
  RunnerHelloSchema,
  RunnerMetadataSchema,
  RunnerPolicyAckSchema,
  RunnerPolicySchema,
  RunnerPolicyUpdateSchema,
  RunnerPolicyWorkspaceSchema,
  RunnerSyncSchema,
  RunnerWelcomeSchema,
  WireMessageSchema,
  WorkerMetadataSchema,
  WorkspaceMetadataSchema,
  ProtectedRpcMethodSchema,
  isProtectedRpcMethod,
} from "./schema.js";
export type {
  CapabilityMetadata,
  JobCompleted,
  JobMetadata,
  JobOutput,
  JobStarted,
  JobStatus,
  JobStatusMessage,
  JsonValue,
  PermissionSet,
  ProtocolVersion,
  ProtocolVersionRange,
  RpcError,
  RpcRequest,
  RpcResponse,
  RunnerHeartbeat,
  RunnerHello,
  RunnerMetadata,
  RunnerPolicyAck,
  RunnerPolicy,
  RunnerPolicyUpdate,
  RunnerPolicyWorkspace,
  RunnerSync,
  RunnerWelcome,
  WireMessage,
  WorkerMetadata,
  WorkspaceMetadata,
  ProtectedRpcMethod,
} from "./schema.js";

export { generateWireMessageJsonSchema } from "./schema-artifact.js";
export {
  RUNNER_DIAGNOSTICS_EXTENSION,
  RUNNER_POLICY_DIAGNOSTICS_EXTENSION,
  RUNNER_DIAGNOSTICS_FEATURE_EXTENSION,
  mergeRunnerDiagnostics,
  mergeWorkspaceDiagnostics,
  parseRunnerDiagnosticsExtension,
  policyDiagnosticsExtension,
  runnerDiagnosticsExtension,
  runnerDiagnosticsFeatureExtension,
  stripRunnerDiagnostics,
  stripWorkspaceDiagnostics,
  supportsDirectPolicyDiagnostics,
} from "./diagnostics.js";
export { canonicalJson, policyWithoutChecksum, runnerPolicyChecksum, sha256Hex } from "./crypto.js";
export {
  FULL_PERMISSION_SET,
  LOCKED_PERMISSION_SET,
  PERMISSION_BITS,
  intersectPermissionSets,
  isCanonicalPermissionSet,
  normalizeUiPermissionSet,
  permissionSetFromScopes,
  restrictPermissionSet,
  validatePermissionSet,
} from "./permissions.js";
export type { PermissionBit as CanonicalPermissionBit } from "./permissions.js";
export type { RunnerPolicyChecksumInput } from "./crypto.js";
export type { RunnerDiagnostics, WorkspaceDiagnostic } from "./diagnostics.js";

export {
  MAX_FRAME_BYTES,
  LOCAL_RUNNER_OPERATION_TIMEOUT_MS,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  PROTOCOL_CURRENT_VERSION,
  PROTOCOL_MIN_VERSION,
  WORKER_BRIDGE_TIMEOUT_MS,
};

export const UNSUPPORTED_PROTOCOL_VERSION = "unsupported_protocol_version" as const;

export interface UnsupportedProtocolVersionError {
  readonly code: typeof UNSUPPORTED_PROTOCOL_VERSION;
  readonly message: string;
  readonly local: ProtocolVersionRange;
  readonly remote: ProtocolVersionRange;
}

export type ProtocolNegotiationResult =
  | { readonly ok: true; readonly protocol_version: ProtocolVersion }
  | { readonly ok: false; readonly error: UnsupportedProtocolVersionError };

/**
 * Selects the highest shared wire major. Implementations retain earlier major
 * decoders in their advertised range, which permits a newer peer to fall back
 * to an older compatible major.
 */
export function negotiateProtocolVersion(
  localInput: ProtocolVersionRange,
  remoteInput: ProtocolVersionRange,
): ProtocolNegotiationResult {
  const local = ProtocolVersionRangeSchema.parse(localInput);
  const remote = ProtocolVersionRangeSchema.parse(remoteInput);
  const minimum = Math.max(
    local.min_protocol_version,
    remote.min_protocol_version,
  );
  const maximum = Math.min(
    local.max_protocol_version,
    remote.max_protocol_version);

  if (minimum > maximum) {
    return {
      ok: false,
      error: {
        code: UNSUPPORTED_PROTOCOL_VERSION,
        message: `No compatible protocol major between local ${local.min_protocol_version}-${local.max_protocol_version} and remote ${remote.min_protocol_version}-${remote.max_protocol_version}`,
        local,
        remote,
      },
    };
  }

  return { ok: true, protocol_version: maximum };
}

/** The supported range for this package version. */
export const LOCAL_PROTOCOL_VERSIONS: ProtocolVersionRange = {
  min_protocol_version: PROTOCOL_MIN_VERSION,
  max_protocol_version: PROTOCOL_CURRENT_VERSION,
};

export class ProtocolFrameError extends Error {
  public constructor(
    public readonly code: "frame_too_large" | "invalid_json" | "invalid_message",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolFrameError";
  }
}

/** Validates and encodes a JSON WebSocket/text frame without exceeding its byte limit. */
export function encodeWireFrame(message: WireMessage): string {
  let ownData: unknown;
  try {
    // Zod object parsing reads fields through normal property lookup.  Clone
    // the caller's tree into null-prototype containers first so a polluted
    // Object.prototype cannot satisfy missing required fields.  The clone
    // also rejects accessors/hidden properties that JSON.stringify would drop.
    ownData = cloneWireInput(message);
  } catch {
    throw new ProtocolFrameError("invalid_message", "Cannot encode an invalid wire message");
  }
  let parsed: ReturnType<typeof WireMessageSchema.safeParse>;
  try {
    parsed = WireMessageSchema.safeParse(ownData);
  } catch {
    throw new ProtocolFrameError("invalid_message", "Cannot encode an invalid wire message");
  }
  if (!parsed.success) {
    throw new ProtocolFrameError("invalid_message", "Cannot encode an invalid wire message");
  }

  let frame: string;
  try {
    // Zod creates ordinary result objects.  Serialize a second safe clone so
    // an inherited Object.prototype.toJSON (or similar global mutation) cannot
    // rewrite the validated message between validation and encoding.
    frame = JSON.stringify(cloneWireInput(parsed.data)) as string;
  } catch {
    throw new ProtocolFrameError("invalid_message", "Cannot encode an invalid wire message");
  }
  const byteLength = new TextEncoder().encode(frame).byteLength;
  if (byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolFrameError(
      "frame_too_large",
      `Wire frame exceeds the ${MAX_FRAME_BYTES}-byte limit`,
    );
  }
  return frame;
}

const MAX_WIRE_CLONE_NODES = MAX_JSON_NODES * 16;
const MAX_ARRAY_INDEX = 4_294_967_295;

/**
 * Copy only own, enumerable, data properties into JSON-safe containers.
 * This is intentionally separate from JsonValueSchema: top-level structured
 * schemas also use ordinary Zod objects, whose parser otherwise permits
 * inherited fields.  The bounded depth keeps hostile local inputs from
 * exhausting the JavaScript call stack before schema validation runs.
 */
function cloneWireInput(value: unknown): unknown {
  const active = new WeakSet<object>();
  const copies = new WeakMap<object, unknown>();
  let nodes = 0;

  const clone = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_WIRE_CLONE_NODES || depth > MAX_JSON_DEPTH + 8) {
      throw new Error("wire value exceeds clone bounds");
    }
    if (current === null || typeof current === "boolean" || typeof current === "string") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("wire number is not finite");
      return current;
    }
    if (typeof current !== "object") throw new Error("wire value is not JSON-safe");

    const source = current as object;
    const existing = copies.get(source);
    if (existing !== undefined) {
      if (active.has(source)) throw new Error("wire values cannot contain cycles");
      return existing;
    }

    if (Array.isArray(source)) {
      const length = source.length;
      if (!Number.isSafeInteger(length) || length > MAX_JSON_NODES) {
        throw new Error("wire array exceeds item bounds");
      }
      for (const key of Reflect.ownKeys(source)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !isCanonicalArrayIndex(key) || Number(key) >= length) {
          throw new Error("wire array has a non-index property");
        }
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new Error("wire array has an accessor");
        }
      }
      const result = new Array<unknown>(length);
      copies.set(source, result);
      active.add(source);
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new Error("wire array contains a hole or accessor");
        }
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: clone(descriptor.value, depth + 1),
          writable: true,
        });
      }
      active.delete(source);
      // Keep inherited methods and toJSON out of the serialization boundary.
      Object.setPrototypeOf(result, null);
      return result;
    }

    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("wire objects must be plain objects");
    }
    const result = Object.create(null) as Record<string, unknown>;
    copies.set(source, result);
    active.add(source);
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== "string") throw new Error("wire objects cannot contain symbols");
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("wire objects must contain enumerable data properties");
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: clone(descriptor.value, depth + 1),
        writable: true,
      });
    }
    active.delete(source);
    return result;
  };

  return clone(value, 0);
}

function isCanonicalArrayIndex(value: string): boolean {
  const index = Number(value);
  return Number.isSafeInteger(index)
    && index >= 0
    && index < MAX_ARRAY_INDEX
    && String(index) === value;
}

/**
 * Decodes a UTF-8 JSON frame, verifies its byte size, and rejects every
 * message outside the closed WireMessageSchema discriminated union.
 */
export function decodeWireFrame(
  frame: string | Uint8Array,
  expectedProtocolVersion?: ProtocolVersion,
): WireMessage {
  let text: string;
  if (typeof frame === "string") {
    if (new TextEncoder().encode(frame).byteLength > MAX_FRAME_BYTES) {
      throw new ProtocolFrameError(
        "frame_too_large",
        `Wire frame exceeds the ${MAX_FRAME_BYTES}-byte limit`,
      );
    }
    text = frame;
  } else {
    if (frame.byteLength > MAX_FRAME_BYTES) {
      throw new ProtocolFrameError(
        "frame_too_large",
        `Wire frame exceeds the ${MAX_FRAME_BYTES}-byte limit`,
      );
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch {
      throw new ProtocolFrameError("invalid_json", "Wire frame is not valid UTF-8");
    }
  }

  let value: unknown;
  try {
    assertBoundedJsonNesting(text);
    // JSON.parse normally creates ordinary objects that inherit from
    // Object.prototype.  A polluted global prototype could therefore supply
    // missing required fields when Zod reads `input[key]`/`key in input`.
    // Build null-prototype objects for decoded JSON so wire validation only
    // observes own properties and cannot inherit attacker-controlled values.
    value = JSON.parse(text, (_key, parsed) => {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return parsed;
      }
      const clean = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of Object.entries(parsed)) {
        Object.defineProperty(clean, key, {
          configurable: true,
          enumerable: true,
          value: item,
          writable: true,
        });
      }
      return clean;
    }) as unknown;
  } catch (error) {
    if (error instanceof ProtocolFrameError) {
      throw error;
    }
    throw new ProtocolFrameError("invalid_json", "Wire frame is not valid JSON");
  }

  let parsed: ReturnType<typeof WireMessageSchema.safeParse>;
  try {
    parsed = WireMessageSchema.safeParse(value);
  } catch {
    throw new ProtocolFrameError("invalid_message", "Wire frame does not match the protocol schema");
  }
  if (!parsed.success) {
    throw new ProtocolFrameError("invalid_message", "Wire frame does not match the protocol schema");
  }
  const parsedMessage = parsed.data as WireMessage;
  if (expectedProtocolVersion !== undefined && parsedMessage.protocol_version !== expectedProtocolVersion) {
    throw new ProtocolFrameError("invalid_message", "Wire frame protocol version was not negotiated");
  }
  return parsedMessage;
}

/** Reject structural nesting before JSON.parse can recurse into hostile input. */
function assertBoundedJsonNesting(text: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH + 8) {
        throw new ProtocolFrameError("invalid_json", "Wire JSON is nested too deeply");
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
}
