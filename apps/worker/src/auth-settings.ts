import { PASSWORD_KDF_ITERATIONS } from "./security.js";
import { boundedJsonResponse } from "./platform/bounded-json.js";

export interface LoginSettings { readonly password_verifier: string; readonly session_version: number }

/** Bound the request and response bytes; an outage is not a wrong password. */
export async function loadLoginSettings(fetchSettings: (signal: AbortSignal) => Promise<Response>, timeoutMs = 5000): Promise<LoginSettings | undefined> {
  const response = await boundedJsonResponse(fetchSettings, timeoutMs);
  if (response?.status !== 200) return undefined;
  const value = response.value as Record<string, unknown> | undefined;
  if (typeof value !== "object" || value === null || typeof value.password_verifier !== "string"
    || typeof value.session_version !== "number" || !Number.isSafeInteger(value.session_version) || value.session_version < 1) return undefined;
  const match = /^pbkdf2-sha256\$(\d+)\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/u.exec(value.password_verifier);
  const iterations = match === null ? 0 : Number(match[1]);
  if (iterations < 10000 || iterations > PASSWORD_KDF_ITERATIONS) return undefined;
  return { password_verifier: value.password_verifier, session_version: value.session_version };
}
