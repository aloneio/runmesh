/**
 * Shared byte-cursor helpers for UTF-8 paginated responses.
 *
 * Cursors are byte positions in the source. For valid UTF-8, every byte that
 * is not a continuation byte starts a code point, so moving forward/backward
 * over continuation bytes produces a decoding boundary without changing the
 * source bytes or emitting replacement characters.
 */
export function utf8ForwardBoundary(data: Uint8Array, requested: number): number {
  let cursor = Math.max(0, Math.min(requested, data.byteLength));
  while (cursor < data.byteLength && isUtf8Continuation(data[cursor] ?? 0)) cursor += 1;
  return cursor;
}

/** Align a cursor backwards to the start of its current UTF-8 code point. */
export function utf8BackwardBoundary(data: Uint8Array, requested: number): number {
  let cursor = Math.max(0, Math.min(requested, data.byteLength));
  while (cursor > 0 && isUtf8Continuation(data[cursor] ?? 0)) cursor -= 1;
  return cursor;
}

/** Largest whole-code-point prefix that fits within a byte budget. */
export function utf8SafePrefixLength(data: Uint8Array, maximum: number): number {
  let end = Math.min(Math.max(0, maximum), data.byteLength);
  if (end === 0) return 0;
  let lead = end - 1;
  while (lead > 0 && isUtf8Continuation(data[lead] ?? 0)) lead -= 1;
  const value = data[lead] ?? 0;
  const width = value < 0x80
    ? 1
    : value >= 0xc2 && value <= 0xdf
      ? 2
      : value >= 0xe0 && value <= 0xef
        ? 3
        : value >= 0xf0 && value <= 0xf4
          ? 4
          : 1;
  if (lead + width > end) end = lead;
  return end;
}

export function isUtf8Continuation(value: number): boolean {
  return value >= 0x80 && value <= 0xbf;
}
