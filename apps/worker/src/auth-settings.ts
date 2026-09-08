import { PASSWORD_KDF_ITERATIONS } from "./security.js";

export interface LoginSettings { readonly password_verifier: string; readonly session_version: number }

/** Bound both the request and body read. An outage is not a wrong password. */
export async function loadLoginSettings(fetchSettings: (signal: AbortSignal) => Promise<Response>, timeoutMs = 5_000): Promise<LoginSettings | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<LoginSettings | undefined> => {
        const response = await fetchSettings(controller.signal);
        if (!response.ok) return undefined;
        const value = await response.json() as Record<string, unknown>;
        if (typeof value !== "object" || value === null || typeof value.password_verifier !== "string"
          || typeof value.session_version !== "number" || !Number.isSafeInteger(value.session_version) || value.session_version < 1) return undefined;
        const match = /^pbkdf2-sha256\$(\d+)\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/u.exec(value.password_verifier);
        const iterations = match === null ? 0 : Number(match[1]);
        if (iterations < 10_000 || iterations > PASSWORD_KDF_ITERATIONS) return undefined;
        return { password_verifier: value.password_verifier, session_version: value.session_version };
      })().catch(() => undefined),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
