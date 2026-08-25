export const INTERNAL_CONTROL_HEADER = "x-internal-control";
export const MAX_BEARER_TOKEN_BYTES = 512;
export const PASSWORD_KDF_ITERATIONS = 120_000;
export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const SETUP_CSRF_TTL_MS = 10 * 60 * 1_000;
export const MCP_SECRET_BYTES = 32;

const encoder = new TextEncoder();

export function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function parseSafeIdentifier(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || !isSafeIdentifier(value)) return undefined;
  return value;
}

export function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("Authorization");
  if (value === null) return undefined;
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(value);
  if (match === null || match[1] === undefined) return undefined;
  const token = match[1];
  return encoder.encode(token).byteLength <= MAX_BEARER_TOKEN_BYTES ? token : undefined;
}

export async function internalHeaders(
  secret: string,
  method: string,
  pathname: string,
  body: string,
): Promise<HeadersInit> {
  const signature = await hmacHex(secret, `${method.toUpperCase()}\n${pathname}\n${body}`);
  return {
    [INTERNAL_CONTROL_HEADER]: signature,
    "content-type": "application/json",
  };
}

export async function verifyInternalRequest(
  request: Request,
  secret: string | undefined,
  body: string,
): Promise<boolean> {
  if (secret === undefined || secret.length === 0) return false;
  const supplied = request.headers.get(INTERNAL_CONTROL_HEADER);
  if (supplied === null || !/^[0-9a-f]{64}$/.test(supplied)) return false;
  const expected = await hmacHex(
    secret,
    `${request.method.toUpperCase()}\n${new URL(request.url).pathname}\n${body}`,
  );
  return constantTimeEqual(supplied, expected);
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function runnerTokenVerifier(token: string, pepper: string): Promise<string> {
  return hmacHex(pepper, token);
}

export function generateRunnerToken(): string {
  return randomHex(32);
}

export function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toHex(value);
}

export function randomBase64Url(bytes = MCP_SECRET_BYTES): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function passwordVerifier(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const digest = await derivePassword(password, salt, PASSWORD_KDF_ITERATIONS);
  return `pbkdf2-sha256$${PASSWORD_KDF_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(digest))}`;
}

export async function verifyPassword(password: string, verifier: string): Promise<boolean> {
  const parts = verifier.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) return false;
  const salt = fromBase64Url(parts[2] ?? "");
  const expected = fromBase64Url(parts[3] ?? "");
  if (salt === undefined || expected === undefined || expected.length !== 32) return false;
  const actual = new Uint8Array(await derivePassword(password, salt, iterations));
  return constantTimeBytesEqual(actual, expected);
}

function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const safeSalt = salt.slice();
  return crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"])
    .then((key) => crypto.subtle.deriveBits({ name: "PBKDF2", salt: safeSalt as unknown as BufferSource, iterations, hash: "SHA-256" }, key, 256));
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function fromBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}
function toHex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
