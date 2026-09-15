import type { ActiveSelection } from "../contracts.js";
import { failureMetadata } from "@aloneio/runmesh-protocol";
import { isRecord } from "./primitives.js";
import type { RpcOperationState } from "@aloneio/runmesh-protocol";
import { safeRunnerContext } from "./selection.js";
import type { ToolCall } from "../contracts.js";
import type { ToolFailure } from "../contracts.js";

export const CONTENT_LIMIT = 32 * 1024;

const STRUCTURED_LIMIT = 64 * 1024;

const utf8Encoder = new TextEncoder();

export function isToolSuccessResult(value: unknown): value is { readonly structuredContent: Record<string, unknown> } {
  return isRecord(value) && value.isError !== true && isRecord(value.structuredContent);
}

export function isRedactionTruncationEnvelope(value: Record<string, unknown>): boolean {
  return value.truncated === true
    && typeof value.data === "string"
    && typeof value.recovery_hint === "string"
    && Object.keys(value).every((key) => key === "truncated" || key === "data" || key === "recovery_hint");
}

export function runnerSuccess(value: unknown, selection: ActiveSelection): unknown {
  const runnerContext = safeRunnerContext(selection.context);
  if (isRecord(value)) return success({ ...value, runner_context: runnerContext });
  return success({ data: value, runner_context: runnerContext });
}

export function runnerFailure(error: ToolFailure["error"], selection: ActiveSelection): unknown {
  return failureWithDetails(error.code, error.message, error.hint, { runner_context: safeRunnerContext(selection.context) }, error.operation_state);
}

export function asToolResult(call: ToolCall): unknown {
  return call.ok ? success(call.value) : call.error.details === undefined
    ? failure(call.error.code, call.error.message, call.error.hint, call.error.operation_state)
    : failureWithDetails(call.error.code, call.error.message, call.error.hint, call.error.details, call.error.operation_state);
}

export function success(value: unknown): { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> } {
  const safe = redactAndBound(value, STRUCTURED_LIMIT);
  const structuredContent = isRecord(safe) ? safe : { data: safe };
  return { content: [{ type: "text", text: boundedText(structuredContent, CONTENT_LIMIT) }], structuredContent };
}

export function failure(code: string, message: string, hint: string, state?: RpcOperationState): { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError: true } {
  const error = { error: { code, message: message.slice(0, 4_096), recovery_hint: hint.slice(0, 4_096), ...failureMetadata(code, state) } };
  return { content: [{ type: "text", text: `Error (${code}): ${error.error.message}\nRecovery: ${error.error.recovery_hint}` }], structuredContent: error, isError: true };
}

export function failureWithDetails(code: string, message: string, hint: string, details: unknown, state?: RpcOperationState): { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError: true } {
  const error = { error: { code, message: message.slice(0, 4_096), recovery_hint: hint.slice(0, 4_096), ...failureMetadata(code, state), details: redactAndBound(details, 8_192) } };
  return { content: [{ type: "text", text: `Error (${code}): ${error.error.message}\nRecovery: ${error.error.recovery_hint}` }], structuredContent: error, isError: true };
}

export function failWithDetails(code: string, message: string, hint: string, details: unknown, state?: RpcOperationState): ToolFailure { return { ok: false, error: { code, message, hint, details, ...failureMetadata(code, state) } }; }

export function fail(code: string, message: string, hint: string, state?: RpcOperationState): ToolFailure { return { ok: false, error: { code, message, hint, ...failureMetadata(code, state) } }; }

export function hintFor(code: string, state?: RpcOperationState): string {
  if (code === "context_storage_full") return "Inspect context storage and review retention for old revisions. A context-count limit requires separately reviewed archival of complete contexts; existing records were not automatically deleted.";
  if (code === "context_plan_changed") return "Review a fresh context retention preview; do not reuse a stale plan hash.";
  if (code === "context_prune_partial") return "Some old revisions may have been removed. Inspect storage and request a fresh preview; no batch rollback or automatic retry occurred.";
  if (code === "context_scan_budget") return "Context inspection exceeded its local budget. Preserve the records for operator review; do not assume the inventory is complete.";
  if (code === "cursor_expired" || code === "cursor_mismatch") return "Start a fresh bounded read for this resource and current policy; do not silently reuse the old offset or re-run a command.";
  if (code === "snapshot_too_large") return "Snapshots are limited to 1 MiB. Explicitly choose live pages for a larger file; no snapshot consistency is then promised.";
  if (state !== undefined && state !== "not_started" && code !== "context_index_stale") return "Inspect the original Job receipt or workspace state; do not repeat a mutation, input or cancellation while its outcome is unresolved.";
  if (code === "log_unavailable") return "Inspect the existing Job and its local log storage; do not re-run the command to retrieve output.";
  if (code === "file_changed" || code === "log_changed") return "Read a fresh bounded page; do not join this result to a page from a changed byte source.";
  if (code === "read_budget_exhausted") return "Reduce the page size and inspect storage availability before reading again.";
  if (code === "runner_offline" || code === "timeout") return "The outcome may be unknown. Inspect the original Job or current workspace before retrying; do not replay input, cancellation or a mutation blindly.";
  if (code === "context_index_missing" || code === "context_index_stale") return "Context records may already be committed. An authorized workspace editor must explicitly rebuild the index before retrying the same checkpoint input and expected revision.";
  if (code === "request_id_conflict") return "Inspect the original Job receipt; do not reuse its request_id for a different command.";
  if (code === "search_snapshot_changed") return "Restart the bounded search with a fresh cursor.";
  if (code === "policy_pending") return "The control plane has a newer policy than the runner. Wait briefly and retry.";
  if (code === "invalid_patch") return "Use the documented *** Begin Patch envelope and exact, non-overlapping hunks.";
  if (code === "missing_file") return "Choose an existing source file or use Add File for a new target.";
  if (code === "target_exists") return "Choose a new target path or update the existing file instead.";
  if (code === "baseline_changed" || code === "expected_hash_mismatch") return "Re-read the affected files and retry with current expected hashes.";
  if (code === "hunk_not_found" || code === "hunk_ambiguous" || code === "hunk_overlap") return "Re-read the file and submit an exact, unambiguous, non-overlapping hunk.";
  if (code === "patch_install_failed" || code === "patch_rollback_failed") return "Inspect workspace state, then retry a smaller patch; no host paths were exposed.";
  if (code === "file_too_large" || code === "not_utf8" || code === "mixed_newlines") return "Use a supported bounded UTF-8 text file or split the change.";
  if (code === "path_traversal" || code === "invalid_path") return "Use a workspace-relative path without .. segments or an absolute path.";
  if (code === "busy" || code === "queue_full") return "Wait for active runner requests to complete, then retry.";
  if (code === "method_not_found") return "Update the runner to a version that supports this tool.";
  return "Inspect the operation state and request details before deciding whether another call is safe.";
}

export function boundedText(value: unknown, max: number): string {
  const text = JSON.stringify(value, null, 2) ?? "null";
  if (utf8Encoder.encode(text).byteLength <= max) return text;
  const marker = "\n… truncated by MCP response limit";
  const markerBytes = utf8Encoder.encode(marker).byteLength;
  return `${truncateUtf8(text, Math.max(0, max - markerBytes))}${marker}`;
}

function redactAndBound(value: unknown, max: number): unknown {
  const redacted = redact(value, new WeakSet());
  const serialized = JSON.stringify(redacted) ?? "null";
  if (utf8Encoder.encode(serialized).byteLength <= max) return redacted;
  return { truncated: true, data: truncateUtf8(serialized, max), recovery_hint: "Use the tool's cursor, offset, or limit fields to paginate." };
}

/** Return a UTF-8 prefix without cutting a Unicode code point in half. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return "";
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const codePointBytes = utf8Encoder.encode(codePoint).byteLength;
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return value.slice(0, end);
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (!isRecord(value) || seen.has(value)) return "[unavailable]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:token|secret|password|verifier|root|cwd|command|pid|process_start_fingerprint|recovery_liveness)/i.test(key)) continue;
    // Define properties explicitly instead of assigning to an ordinary
    // object.  A hostile RPC result can contain an own `__proto__` key;
    // `output[key] = ...` would invoke Object.prototype's legacy setter and
    // mutate the redaction envelope's prototype.
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: redact(item, seen),
      writable: true,
    });
  }
  return output;
}
