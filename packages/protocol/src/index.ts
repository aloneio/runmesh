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
  ProtocolVersionRangeSchema,
  ProtocolVersionSchema,
  RpcErrorDetailsSchema,
  RpcErrorSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  RunnerHeartbeatSchema,
  RunnerHelloSchema,
  RunnerMetadataSchema,
  RunnerSyncSchema,
  RunnerWelcomeSchema,
  WireMessageSchema,
  WorkerMetadataSchema,
  WorkspaceMetadataSchema,
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
  ProtocolVersion,
  ProtocolVersionRange,
  RpcError,
  RpcRequest,
  RpcResponse,
  RunnerHeartbeat,
  RunnerHello,
  RunnerMetadata,
  RunnerSync,
  RunnerWelcome,
  WireMessage,
  WorkerMetadata,
  WorkspaceMetadata,
} from "./schema.js";

export { generateWireMessageJsonSchema } from "./schema-artifact.js";

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
  const parsed = WireMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new ProtocolFrameError("invalid_message", "Cannot encode an invalid wire message");
  }

  const frame = JSON.stringify(parsed.data);
  const byteLength = new TextEncoder().encode(frame).byteLength;
  if (byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolFrameError(
      "frame_too_large",
      `Wire frame exceeds the ${MAX_FRAME_BYTES}-byte limit`,
    );
  }
  return frame;
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
    value = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ProtocolFrameError) {
      throw error;
    }
    throw new ProtocolFrameError("invalid_json", "Wire frame is not valid JSON");
  }

  const parsed = WireMessageSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProtocolFrameError("invalid_message", "Wire frame does not match the protocol schema");
  }
  if (expectedProtocolVersion !== undefined && parsed.data.protocol_version !== expectedProtocolVersion) {
    throw new ProtocolFrameError("invalid_message", "Wire frame protocol version was not negotiated");
  }
  return parsed.data;
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
