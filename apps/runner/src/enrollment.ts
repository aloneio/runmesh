import { hostname } from "node:os";
import { PROTOCOL_CURRENT_VERSION } from "@remote-coding-runtime/protocol";
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
}
export interface EnrollmentResult { readonly profile: RunnerProfile; }
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Redeems one enrollment code exactly once; the code is never written to disk or output. */
export async function enrollRunner(options: EnrollmentOptions): Promise<EnrollmentResult> {
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
  const body = await response.json().catch(() => undefined);
  const enrolled = enrollmentResponse(body);
  if (enrolled === undefined) throw new Error("enrollment response is invalid");
  const store = options.store ?? new ProfileStore();
  const existing = await store.load();
  // Enrollment represents a machine Runner. It intentionally never infers a local
  // workspace from process.cwd() (or from the legacy cwd option). Initial
  // enrollment therefore has zero workspaces; re-enrollment keeps explicitly
  // configured roots while replacing only connection credentials.
  const profile: RunnerProfile = {
    version: 1,
    server_url: connectionUrl(enrolled.serverUrl),
    runner_id: enrolled.runnerId,
    token: enrolled.token,
    workspaces: existing?.workspaces ?? [],
    ...(options.insecureLocal === true ? { insecure_local: true } : {}),
    ...(existing?.max_concurrent_jobs === undefined ? {} : { max_concurrent_jobs: existing.max_concurrent_jobs }),
  };
  await store.save(profile);
  return { profile };
}

function enrollmentEndpoint(value: string, insecureLocal: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("--server must be an https:// enrollment URL"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && insecureLocal)) throw new Error("https:// is required; use --insecure-local only for loopback http:// enrollment");
  if (url.pathname !== "/runner/enroll") url.pathname = url.pathname.endsWith("/") ? `${url.pathname}runner/enroll` : `${url.pathname}/runner/enroll`;
  url.search = "";
  return url.toString();
}
function connectionUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("enrollment response has an invalid server URL"); }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("enrollment response has an invalid server URL");
  return url.toString();
}
function enrollmentResponse(value: unknown): { readonly runnerId: string; readonly serverUrl: string; readonly token: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.runner_id !== "string" || !SAFE_ID.test(item.runner_id) || typeof item.server_url !== "string" || typeof item.token !== "string" || item.token.length < 16 || /\s/.test(item.token)) return undefined;
  return { runnerId: item.runner_id, serverUrl: item.server_url, token: item.token };
}
