import { isSafeIdentifier } from "../security.js";
import { SUPPORTED_SCOPES, type CodingScope } from "./catalog.js";

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
  if (typeof record.client_id !== "string" || !isSafeIdentifier(record.client_id)
    || !Number.isSafeInteger(record.secret_version) || (record.secret_version as number) < 1
    || !Array.isArray(record.scopes) || record.scopes.length > SUPPORTED_SCOPES.length
    || new Set(record.scopes).size !== record.scopes.length
    || record.scopes.some(scope => !SUPPORTED_SCOPES.includes(scope as CodingScope))) return { state: "malformed" };
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const observe = async (): Promise<ReauthorizationDecision> => {
    try {
      const response = await fetchDecision(controller.signal);
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); return { state: "unavailable" }; }
      if ([401, 403, 404].includes(response.status)) { void response.body?.cancel().catch(() => undefined); return { state: "denied" }; }
      if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); return { state: "unavailable" }; }
      if (response.body === null) return { state: "malformed" };
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      for (let reads = 0; ; reads++) {
        if (controller.signal.aborted) return { state: "unavailable" };
        if (reads >= 256) return { state: "malformed" };
        const item = await reader.read();
        if (item.done) break;
        if (!(item.value instanceof Uint8Array) || (size += item.value.byteLength) > 16384) return { state: "malformed" };
        chunks.push(item.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return projectReauthorization(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), expected); }
      catch { return { state: "malformed" }; }
    } catch { return { state: "unavailable" }; }
    finally {
      if (reader !== undefined) { void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* a pending read settles after cancellation */ } }
    }
  };
  try {
    return await Promise.race([
      observe(),
      new Promise<ReauthorizationDecision>(resolve => {
        timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => undefined); resolve({ state: "unavailable" }); }, timeoutMs);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
