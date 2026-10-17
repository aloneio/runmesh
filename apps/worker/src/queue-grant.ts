import { canonicalJson, QueueGrantSchema, QueueGrantPayloadSchema, type QueueGrant, type QueueGrantPayload } from "@aloneio/runmesh-protocol";
const encoder = new TextEncoder();
const QUEUE_GRANT_DOMAIN = "runmesh-queue-v1:";

/**
 * Sign the payload with canonical key ordering rather than relying on the insertion order
 * of an object received from another implementation. The legacy form is
 * retained by verification so a rolling Worker/Runner upgrade does not
 * invalidate grants issued immediately before the deploy.
 */
function canonicalGrantPayload(payload: QueueGrantPayload): string {
  return canonicalJson(payload);
}

function legacyGrantPayload(payload: QueueGrantPayload): string { return JSON.stringify(payload); }

export function launchInput(params: Record<string, unknown>): string {
  const input = JSON.parse(JSON.stringify({
    workspace_id: params.workspace_id,
    command: params.command,
    args: params.args ?? null,
    shell: params.shell,
    cwd: params.cwd ?? ".",
    request_id: params.request_id ?? null,
    ...(typeof params.record_history === "boolean" ? { record_history: params.record_history } : {}),
  })) as Record<string, unknown>;
  return canonicalJson(input);
}
export async function launchDigest(params: Record<string, unknown>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(launchInput(params))));
}
function hex(buffer: ArrayBuffer): string { return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2,"0")).join(""); }
async function key(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("Queue signing is not configured");
  return crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign","verify"]);
}
export async function signQueueGrant(secret: string, payload: QueueGrantPayload): Promise<QueueGrant> {
  const checked = QueueGrantPayloadSchema.parse(payload);
  return { payload: checked, signature: hex(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(QUEUE_GRANT_DOMAIN + canonicalGrantPayload(checked)))) };
}
export async function verifyQueueGrant(secret: string, input: unknown, now = Date.now()): Promise<QueueGrantPayload | undefined> {
  const parsed = QueueGrantSchema.safeParse(input); if (!parsed.success) return undefined;
  const {payload,signature} = parsed.data;
  if (payload.expires_at_ms <= now || payload.expires_at_ms > now + 3600000) return undefined;
  const bytes = Uint8Array.from(signature.match(/../g)!, b => parseInt(b,16));
  const signingKey = await key(secret);
  const canonical = await crypto.subtle.verify("HMAC", signingKey, bytes, encoder.encode(QUEUE_GRANT_DOMAIN + canonicalGrantPayload(payload)));
  if (canonical) return payload;
  // Accept grants created by the pre-canonicalization implementation during a
  // rolling deployment. Newly issued grants always use the canonical form.
  return await crypto.subtle.verify("HMAC", signingKey, bytes, encoder.encode(QUEUE_GRANT_DOMAIN + legacyGrantPayload(payload))) ? payload : undefined;
}
