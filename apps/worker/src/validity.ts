export interface ValidityWindow {
  readonly valid_from_ms: number | null;
  readonly valid_until_ms: number | null;
}
export type ValidityStatus = "active" | "scheduled" | "expired";

export function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999;
}
export function validWindow(value: ValidityWindow): boolean {
  return (value.valid_from_ms === null || validTimestamp(value.valid_from_ms))
    && (value.valid_until_ms === null || validTimestamp(value.valid_until_ms))
    && (value.valid_from_ms === null || value.valid_until_ms === null || value.valid_until_ms > value.valid_from_ms);
}
export function validityStatus(value: ValidityWindow, nowMs = Date.now()): ValidityStatus {
  if (!validWindow(value) || value.valid_until_ms !== null && nowMs >= value.valid_until_ms) return "expired";
  return value.valid_from_ms !== null && nowMs < value.valid_from_ms ? "scheduled" : "active";
}
