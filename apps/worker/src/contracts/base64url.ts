/** Canonical byte encoding shared by persisted secrets, verifiers and cursors. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string, maxCharacters: number): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > maxCharacters) return undefined;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(normalized), character => character.charCodeAt(0));
    return encodeBase64Url(bytes) === value ? bytes : undefined;
  } catch { return undefined; }
}
