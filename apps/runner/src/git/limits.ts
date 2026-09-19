import { LOCAL_RUNNER_OPERATION_TIMEOUT_MS } from "@aloneio/runmesh-protocol";
import { MAX_FRAME_BYTES } from "@aloneio/runmesh-protocol";
import { PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";

export const DEFAULT_OUTPUT_BYTES = 256 * 1_024;

export const MAX_OUTPUT_BYTES = MAX_FRAME_BYTES;

export const MAX_REQUEST_ID_BYTES = 128;

const RPC_RESPONSE_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({
  type: "rpc.response",
  protocol_version: PROTOCOL_CURRENT_VERSION,
  request_id: "x".repeat(MAX_REQUEST_ID_BYTES),
  result: null,
}), "utf8");

// escaping and metadata are accounted for below.
export const MAX_PROCESS_OUTPUT_BYTES = MAX_FRAME_BYTES - RPC_RESPONSE_ENVELOPE_BYTES;

export const GIT_TIMEOUT_MS = LOCAL_RUNNER_OPERATION_TIMEOUT_MS;

export const KILL_GRACE_MS = 250;

export const HARD_KILL_MS = 1_000;

export const MAX_GIT_METADATA_BYTES = 4 * 1_024 * 1_024;
