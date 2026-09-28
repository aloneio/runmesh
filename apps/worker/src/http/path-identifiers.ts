import { isSafeIdentifier } from "../security.js";

/** Decode one identifier segment exactly once; never decode a whole signed URL. */
export function decodePathIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return isSafeIdentifier(decoded) ? decoded : undefined;
  } catch { return undefined; }
}

/** Static routes remain literal. Only the named identifier captures are decoded. */
export function matchIdentifierPath(pattern: RegExp, pathname: string, identifiers: readonly number[] = [1]): RegExpExecArray | null {
  const match = pattern.exec(pathname);
  if (match === null) return null;
  for (const index of identifiers) {
    const identifier = decodePathIdentifier(match[index]);
    if (identifier === undefined) return null;
    match[index] = identifier;
  }
  return match;
}
