export const INTERNAL_CONTROL_HEADER = "x-internal-control";
export const MAX_BEARER_TOKEN_BYTES = 512;

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
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
