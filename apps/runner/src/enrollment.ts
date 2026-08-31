import { hostname } from "node:os";
import { PROTOCOL_CURRENT_VERSION } from "@aloneio/runmesh-protocol";
import { ProfileStore, type RunnerProfile } from "./profile.js";
import { RUNNER_VERSION } from "./version.js";

export interface EnrollmentOptions {
  readonly server: string;
  readonly code: string;
  /** Retained for explicit CLI compatibility; enrollment never derives a workspace from it. */
  readonly cwd?: string;
  readonly store?: ProfileStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly insecureLocal?: boolean;
  /** Persisted machine-service identity. New enrollments default to dedicated_user. */
  readonly executionMode?: "dedicated_user" | "privileged_host";
  /** Explicit acknowledgement required when selecting privileged_host. */
  readonly confirmPrivilegedHost?: boolean;
  /** Explicit acknowledgement required before replacing an existing profile's credentials. */
  readonly reEnroll?: boolean;
}
export interface EnrollmentResult { readonly profile: RunnerProfile; }
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ENROLLMENT_RESPONSE_BYTES = 64 * 1024;

/** Redeems one enrollment code exactly once; the code is never written to disk or output. */
export async function enrollRunner(options: EnrollmentOptions): Promise<EnrollmentResult> {
  if (options.executionMode !== undefined && options.executionMode !== "dedicated_user" && options.executionMode !== "privileged_host") throw new Error("--execution-mode must be dedicated_user or privileged_host");
  if (options.executionMode === "privileged_host" && options.confirmPrivilegedHost !== true) throw new Error("privileged_host execution mode requires --confirm-privileged-host");
  const store = options.store ?? new ProfileStore();
  const existing = await store.load();
  if (existing !== undefined && options.reEnroll !== true) throw new Error("an existing Runner profile was found; use --re-enroll to replace its connection credentials");
  const endpoint = enrollmentEndpoint(options.server, options.insecureLocal === true);
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(options.code)) throw new Error("--code must be a one-time enrollment code");
  const request = options.fetch ?? globalThis.fetch;
  const response = await request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enrollment_code: options.code,
      runner_public_info: { platform: process.platform, architecture: process.arch, hostname: hostname().slice(0, 256), runner_version: RUNNER_VERSION, protocol_version: PROTOCOL_CURRENT_VERSION },
    }),
  }).catch(() => { throw new Error("enrollment request failed"); });
  if (!response.ok) throw new Error(`enrollment failed (${response.status})`);
  const body = await readCappedJson(response).catch(() => undefined);
  const enrolled = enrollmentResponse(body);
  if (enrolled === undefined) throw new Error("enrollment response is invalid");
  // Enrollment represents a machine Runner. It intentionally never infers a local
  // workspace from process.cwd() (or from the legacy cwd option). Initial
  // enrollment therefore has zero workspaces; re-enrollment keeps explicitly
  // configured roots while replacing only connection credentials.
  const profile: RunnerProfile = {
    version: 1,
    server_url: connectionUrl(enrolled.serverUrl, new URL(endpoint), options.insecureLocal === true),
    runner_id: enrolled.runnerId,
    token: enrolled.token,
    workspaces: existing?.workspaces ?? [],
    ...(options.insecureLocal === true ? { insecure_local: true } : {}),
    ...(existing?.max_concurrent_jobs === undefined ? {} : { max_concurrent_jobs: existing.max_concurrent_jobs }),
    ...(options.executionMode === undefined
      ? existing?.execution_mode === undefined ? { execution_mode: "dedicated_user" as const } : { execution_mode: existing.execution_mode }
      : { execution_mode: options.executionMode }),
    ...(existing === undefined
      ? { management_mode: "central" as const }
      : existing.management_mode === undefined ? {} : { management_mode: existing.management_mode }),
  };
  await store.save(profile);
  return { profile };
}

function enrollmentEndpoint(value: string, insecureLocal: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("--server must be an https:// enrollment URL"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("--server must not contain credentials, query parameters, or a fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && insecureLocal)) throw new Error("https:// is required; use --insecure-local only for loopback http:// enrollment");
  if (url.pathname !== "/runner/enroll") url.pathname = url.pathname.endsWith("/") ? `${url.pathname}runner/enroll` : `${url.pathname}/runner/enroll`;
  url.search = "";
  return url.toString();
}
function connectionUrl(value: string, enrollment: URL, insecureLocal: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("enrollment response has an invalid server URL"); }
  const loopback = isLoopback(url.hostname);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("enrollment response has an unsafe server URL");
  const expectedOrigin = transportOrigin(enrollment);
  const responseOrigin = transportOrigin(url);
  if (responseOrigin !== expectedOrigin) throw new Error("enrollment response server URL does not match the enrollment endpoint");
  const expectedPath = enrollment.pathname.endsWith("/runner/enroll")
    ? `${enrollment.pathname.slice(0, -"/runner/enroll".length)}/runner/connect` || "/runner/connect"
    : "/runner/connect";
  if (url.pathname.replace(/\/+$/, "") !== expectedPath.replace(/\/+$/, "")) throw new Error("enrollment response has an unexpected server path");
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:" && loopback) url.protocol = "ws:";
  else if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("enrollment response has an invalid server URL");
  if (url.protocol === "ws:" && (!insecureLocal || !loopback)) throw new Error("enrollment response requires wss:// except explicit loopback development");
  return url.toString();
}
function isLoopback(hostnameValue: string): boolean {
  const hostnameValueNormalized = hostnameValue.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return hostnameValueNormalized === "127.0.0.1" || hostnameValueNormalized === "localhost" || hostnameValueNormalized === "::1";
}
function transportOrigin(url: URL): string {
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const clear = url.protocol === "http:" || url.protocol === "ws:";
  if (!secure && !clear) throw new Error("enrollment response has an invalid server URL");
  return `${secure ? "https" : "http"}://${url.host}`.toLowerCase();
}

async function readCappedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_ENROLLMENT_RESPONSE_BYTES)) throw new Error("enrollment response is too large");
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > MAX_ENROLLMENT_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("enrollment response is too large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { return undefined; }
}
function enrollmentResponse(value: unknown): { readonly runnerId: string; readonly serverUrl: string; readonly token: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.runner_id !== "string" || !SAFE_ID.test(item.runner_id) || typeof item.server_url !== "string" || typeof item.token !== "string" || item.token.length < 16 || /\s/.test(item.token)) return undefined;
  return { runnerId: item.runner_id, serverUrl: item.server_url, token: item.token };
}
