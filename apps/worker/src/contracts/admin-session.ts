import type { JsonReceipt } from "./control-plane-receipts.js";

/** Administrator authority is shared by native, MCP and Skill administration. */
export type AdminDecision = "allowed" | "denied" | "unavailable";
export type AdminSessionReceipt =
  | { readonly state: "allowed"; readonly csrf_hash: string }
  | { readonly state: "denied" | "unavailable" };

export function isAdminSessionDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** Project one fresh Registry receipt. Callers retain authentication I/O,
 * cancellation and deadlines; this result is never a cached grant. */
export function projectAdminSessionReceipt(receipt: JsonReceipt): AdminSessionReceipt {
  if (receipt === undefined) return { state: "unavailable" };
  if ([401, 403, 404].includes(receipt.status)) return { state: "denied" };
  if (receipt.status !== 200 || typeof receipt.value !== "object" || receipt.value === null || Array.isArray(receipt.value))
    return { state: "unavailable" };
  const csrfHash = (receipt.value as Record<string, unknown>).csrf_hash;
  return isAdminSessionDigest(csrfHash) ? { state: "allowed", csrf_hash: csrfHash } : { state: "unavailable" };
}
