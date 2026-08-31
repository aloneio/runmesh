export const INTERNAL_CONTROL_HEADER = "x-internal-control";
export const INTERNAL_SIGNATURE_VERSION_HEADER = "x-internal-control-version";
export const INTERNAL_TIMESTAMP_HEADER = "x-internal-control-timestamp";
export const INTERNAL_NONCE_HEADER = "x-internal-control-nonce";
export const INTERNAL_SIGNATURE_VERSION = "v1";
export const INTERNAL_SIGNATURE_SKEW_MS = 5 * 60 * 1_000;
export const MAX_BEARER_TOKEN_BYTES = 512;
export const PASSWORD_KDF_ITERATIONS = 100_000;
export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const SETUP_CSRF_TTL_MS = 10 * 60 * 1_000;
export const MCP_SECRET_BYTES = 32;

const encoder = new TextEncoder();
// HTTP credentials must not contain C0/C1 control bytes or DEL.  Printable
// punctuation remains valid for backwards compatibility with manually chosen
// deployment secrets, while values that a header implementation may interpret
// as framing/whitespace are rejected consistently at the boundary.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export function containsControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

/** A configured secret must be a non-empty string before it reaches WebCrypto. */
export function isConfiguredSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

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
  return !containsControlCharacter(token) && encoder.encode(token).byteLength <= MAX_BEARER_TOKEN_BYTES ? token : undefined;
}

export interface InternalSignatureOptions {
  readonly timestamp?: number;
  readonly nonce?: string;
}

export type InternalNonceConsumer = (nonce: string, expiresAtMs: number) => boolean | Promise<boolean>;

/**
 * Sign an internal Durable Object request. The versioned canonical value binds
 * every property that could alter routing or request semantics.
 */
export async function internalHeaders(
  secret: string,
  method: string,
  pathnameAndQuery: string,
  body: string,
  options: InternalSignatureOptions = {},
): Promise<HeadersInit> {
  if (!isConfiguredSecret(secret)) throw new Error("internal control secret must be configured");
  const timestamp = options.timestamp ?? Date.now();
  const nonce = options.nonce ?? randomHex(32);
  const bodyHash = await sha256Hex(body);
  const signature = await hmacHex(secret, internalSignatureValue(
    INTERNAL_SIGNATURE_VERSION,
    method,
    pathnameAndQuery,
    timestamp,
    nonce,
    bodyHash,
  ));
  return {
    [INTERNAL_CONTROL_HEADER]: signature,
    [INTERNAL_SIGNATURE_VERSION_HEADER]: INTERNAL_SIGNATURE_VERSION,
    [INTERNAL_TIMESTAMP_HEADER]: String(timestamp),
    [INTERNAL_NONCE_HEADER]: nonce,
    "content-type": "application/json",
  };
}

/** Verify and atomically consume a one-time internal request nonce. */
export async function verifyInternalRequest(
  request: Request,
  secret: string | undefined,
  body: string,
  consumeNonce: InternalNonceConsumer,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!isConfiguredSecret(secret)) return false;
  const version = request.headers.get(INTERNAL_SIGNATURE_VERSION_HEADER);
  const timestampText = request.headers.get(INTERNAL_TIMESTAMP_HEADER);
  const nonce = request.headers.get(INTERNAL_NONCE_HEADER);
  const supplied = request.headers.get(INTERNAL_CONTROL_HEADER);
  if (version !== INTERNAL_SIGNATURE_VERSION || timestampText === null || nonce === null || supplied === null) return false;
  if (!/^\d{13}$/.test(timestampText) || !/^[0-9a-f]{64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(supplied)) return false;
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowMs - timestamp) > INTERNAL_SIGNATURE_SKEW_MS) return false;
  const url = new URL(request.url);
  const expected = await hmacHex(
    secret,
    internalSignatureValue(version, request.method, `${url.pathname}${url.search}`, timestamp, nonce, await sha256Hex(body)),
  );
  if (!constantTimeEqual(supplied, expected)) return false;
  return consumeNonce(nonce, timestamp + INTERNAL_SIGNATURE_SKEW_MS);
}

function internalSignatureValue(
  version: string,
  method: string,
  pathnameAndQuery: string,
  timestamp: number,
  nonce: string,
  bodyHash: string,
): string {
  return `${version}\n${method.toUpperCase()}\n${pathnameAndQuery}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export async function verifySetupToken(
  supplied: FormDataEntryValue | null,
  setupToken: string | undefined,
  setupTokenHash: string | undefined,
): Promise<boolean> {
  if (typeof supplied !== "string" || supplied.length === 0 || supplied.length > 1_024 || containsControlCharacter(supplied)) return false;
  if (setupTokenHash !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(setupTokenHash)) return false;
    return constantTimeEqual(await sha256Hex(supplied), setupTokenHash.toLowerCase());
  }
  return setupToken !== undefined && setupToken.length > 0
    && constantTimeEqual(await sha256Hex(supplied), await sha256Hex(setupToken));
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
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
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
  if (!Number.isSafeInteger(iterations) || iterations < 10_000 || iterations > PASSWORD_KDF_ITERATIONS) return false;
  const salt = fromBase64Url(parts[2] ?? "");
  const expected = fromBase64Url(parts[3] ?? "");
  if (salt === undefined || expected === undefined || expected.length !== 32) return false;
  try {
    const actual = new Uint8Array(await derivePassword(password, salt, iterations));
    return constantTimeBytesEqual(actual, expected);
  } catch {
    return false;
  }
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
