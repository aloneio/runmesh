import { MAX_ADMIN_BODY_BYTES } from "./constants.js";
import { readCappedText as readBodyText } from "../body.js";
import { readCappedFormData } from "../body.js";
import { record } from "../values.js";

export async function formData(request: Request): Promise<FormData | undefined> { return readCappedFormData(request, MAX_ADMIN_BODY_BYTES); }

export async function readAdminBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const body = await readBodyText(request, MAX_ADMIN_BODY_BYTES);
  if (body === undefined) return undefined;
  try { const value = JSON.parse(body) as unknown; return record(value); } catch { return undefined; }
}

export async function discardBody(request: Request): Promise<void> {
  // Do not allocate an unbounded invalid request body before returning an auth
  // response. Cancelling the stream releases the Worker-side reader.
  try { void request.body?.cancel().catch(() => undefined); } catch { /* already consumed */ }
}
