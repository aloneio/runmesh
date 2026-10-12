import { isSafeIdentifier } from "../security.js";
import { parseClientIdentity, parseNativeScopes, type CodingScope } from "../contracts/identity.js";
import { reportControlPlaneFailure, type ControlPlaneFailureOutcome } from "../platform/control-plane-diagnostics.js";

export type ReauthorizationDecision =
  | { readonly state: "allowed"; readonly scopes: readonly CodingScope[] }
  | { readonly state: "denied" | "unavailable" | "malformed" };
export interface CapturedPrincipal { readonly client_id: string; readonly secret_version: unknown }

/** This response is an observation, never a cached authorization grant. Only
 * the revalidation endpoint's explicit denial or a valid mismatched principal
 * indicates rejection. A failed dependency must not claim credential expiry. */
export function projectReauthorization(value: unknown, expected: CapturedPrincipal): ReauthorizationDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { state: "malformed" };
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "schema_version")) {
    const identity = parseClientIdentity(record);
    if (identity === undefined) return { state: "malformed" };
    if (identity.client_id !== expected.client_id || identity.secret_version !== expected.secret_version) return { state: "denied" };
    return { state: "allowed", scopes: identity.native_scopes };
  }
  if (typeof record.client_id !== "string" || !isSafeIdentifier(record.client_id)
    || !Number.isSafeInteger(record.secret_version) || (record.secret_version as number) < 1
    || parseNativeScopes(record.scopes) === undefined) return { state: "malformed" };
  if (record.client_id !== expected.client_id || record.secret_version !== expected.secret_version) return { state: "denied" };
  return { state: "allowed", scopes: record.scopes as CodingScope[] };
}

/** Exactly one fetch. A finite request-local deadline covers signing, network
 * and body reads; there are no retries, recurring timers or durable writes. */
export async function reauthorizePrincipal(
  fetchDecision: (signal: AbortSignal) => Promise<Response>, expected: CapturedPrincipal, timeoutMs = 5000,
): Promise<ReauthorizationDecision> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return { state: "unavailable" };
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const expired = (): boolean => controller.signal.aborted || performance.now() >= deadline;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let reported = false, responseStatus: number | undefined;
  const report = (outcome: ControlPlaneFailureOutcome, error?: unknown): void => {
    if (reported) return;
    reported = true;
    reportControlPlaneFailure("mcp_reauthorize", outcome, error, responseStatus);
  };
  const observe = async (): Promise<ReauthorizationDecision> => {
    try {
      const response = await fetchDecision(controller.signal);
      responseStatus = response.status;
      if (expired()) { report("deadline"); void response.body?.cancel().catch(() => undefined); return { state: "unavailable" }; }
      if ([401, 403, 404].includes(response.status)) { void response.body?.cancel().catch(() => undefined); return { state: "denied" }; }
      if (response.status !== 200) { report("unexpected_status"); void response.body?.cancel().catch(() => undefined); return { state: "unavailable" }; }
      if (response.body === null) { report("empty_body"); return { state: "malformed" }; }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      for (let reads = 0; ; reads++) {
        if (expired()) { report("deadline"); return { state: "unavailable" }; }
        if (reads >= 256) { report("fragment_limit"); return { state: "malformed" }; }
        const item = await reader.read();
        // Promise continuations can run before the timer callback. Recheck
        // elapsed time after every read, including the final done receipt.
        if (expired()) { report("deadline"); return { state: "unavailable" }; }
        if (item.done) break;
        if (!(item.value instanceof Uint8Array)) { report("invalid_receipt"); return { state: "malformed" }; }
        if ((size += item.value.byteLength) > 16384) { report("body_limit"); return { state: "malformed" }; }
        chunks.push(item.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (expired()) { report("deadline"); return { state: "unavailable" }; }
        const projected = projectReauthorization(value, expected);
        if (projected.state === "malformed") report("invalid_receipt");
        return projected;
      }
      catch (error) { report("invalid_json", error); return { state: "malformed" }; }
    } catch (error) { report("exception", error); return { state: "unavailable" }; }
    finally {
      if (reader !== undefined) { void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* a pending read settles after cancellation */ } }
    }
  };
  try {
    return await Promise.race([
      observe(),
      new Promise<ReauthorizationDecision>(resolve => {
        timer = setTimeout(() => { report("deadline"); controller.abort(); void reader?.cancel().catch(() => undefined); resolve({ state: "unavailable" }); }, timeoutMs);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
