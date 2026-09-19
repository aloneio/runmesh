

export function safePositiveIntegerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function copyContextText(source: Record<string, unknown>, target: Record<string, unknown>, key: string, max: number): void {
  const value = source[key];
  if (typeof value === "string" && value.length <= max && !hasControlCharacters(value)) target[key] = value;
}

export function copySafeWorkspaceId(value: Record<string, unknown>, output: Record<string, unknown>): void {
  const id = safeJobIdentifier(value.workspace_id);
  if (id !== undefined) output.workspace_id = id;
}

export function copySafeRelativePath(value: Record<string, unknown>, output: Record<string, unknown>, key: string): void {
  const path = safeRelativePathValue(value[key]);
  if (path !== undefined) output[key] = path;
}

export function copySafeCursorFields(value: Record<string, unknown>, output: Record<string, unknown>): void {
  if (value.next_cursor === null || isSafeCursor(value.next_cursor)) output.next_cursor = value.next_cursor;
  if (typeof value.truncated === "boolean") output.truncated = value.truncated;
}

export function copySafeInteger(value: Record<string, unknown>, output: Record<string, unknown>, key: string): void {
  if (isSafeNonnegativeInteger(value[key])) output[key] = value[key];
}

export function safeRelativePathValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 4_096 && isSafeRelativePath(value) ? value : undefined;
}

export function safeDirectoryName(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !hasControlCharacters(value) && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

export function hasControlCharacters(value: string): boolean { return /[\u0000-\u001f\u007f-\u009f]/u.test(value); }

export function isSafePositiveInteger(value: unknown): value is number { return isSafeNonnegativeInteger(value) && value > 0; }

export function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }

export function isSafeMode(value: unknown): value is number { return isSafeNonnegativeInteger(value) && value <= 0o7777; }

export function safeJobStatus(value: unknown): string {
  return value === "queued" || value === "running" || value === "cancelling" || value === "cancelled" || value === "succeeded" || value === "failed" || value === "unknown" || value === "interrupted" ? value : "unknown";
}

export function safeJobIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) ? value : undefined;
}

export function isSafeCursor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^(?:\d+|s1:[a-f0-9]{16}:\d+)$/u.test(value);
}

export function isSafeExitCode(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 2 ** 31;
}

export function copyRequiredTimestamp(value: Record<string, unknown>, output: Record<string, unknown>, key: string): void {
  if (isSafeNonnegativeInteger(value[key])) output[key] = value[key];
}

export function copyNullableTimestamp(value: Record<string, unknown>, output: Record<string, unknown>, key: string): void {
  if (value[key] === null || isSafeNonnegativeInteger(value[key])) output[key] = value[key];
}

export function safeSignal(value: unknown): string | null | undefined {
  if (value === null) return null;
  // Signals are a finite, protocol-level enum in current Runners.  Do not
  // let a stale/malformed peer use this short field as a filesystem/path
  // side-channel.
  return typeof value === "string" && value.length <= 32 && /^(?:SIG[A-Z0-9]+|[A-Z][A-Z0-9_]{0,31})$/u.test(value)
    ? value
    : undefined;
}

export function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function safeLifecycleId(value: string): boolean {
  return value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isSafeRelativePath(value: string): boolean {
  // Reject POSIX absolute, Windows drive-qualified, and UNC/device paths at
  // the MCP boundary before they reach a runner on another platform.
  return !value.includes("\0") && !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes("..");
}

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
