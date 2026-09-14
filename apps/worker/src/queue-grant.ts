import { QueueGrantSchema, QueueGrantPayloadSchema, type QueueGrant, type QueueGrantPayload } from "@aloneio/runmesh-protocol";
const encoder = new TextEncoder();
export function launchInput(params: Record<string, unknown>): string {
  return JSON.stringify({ workspace_id: params.workspace_id, command: params.command, shell: params.shell, cwd: params.cwd ?? ".", request_id: params.request_id ?? null });
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
  return { payload: checked, signature: hex(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode("runmesh-queue-v1:"+JSON.stringify(checked)))) };
}
export async function verifyQueueGrant(secret: string, input: unknown, now = Date.now()): Promise<QueueGrantPayload | undefined> {
  const parsed = QueueGrantSchema.safeParse(input); if (!parsed.success) return undefined;
  const {payload,signature} = parsed.data;
  if (payload.expires_at_ms <= now || payload.expires_at_ms > now + 3600000) return undefined;
  const bytes = Uint8Array.from(signature.match(/../g)!, b => parseInt(b,16));
  return await crypto.subtle.verify("HMAC",await key(secret),bytes,encoder.encode("runmesh-queue-v1:"+JSON.stringify(payload))) ? payload : undefined;
}
