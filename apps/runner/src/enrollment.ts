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

/**
 * The enrollment endpoint consumes a one-time code before returning the new
 * credential.  A transport failure, an unavailable response, or an invalid
 * success body therefore cannot safely be treated as a simple rejection: the
 * server may already have replaced the old credential.  Callers use this
 * marker to fail closed and remove any local profile rather than attempting to
 * reconnect with a potentially stale token.
 */
export const ENROLLMENT_OUTCOME_UNKNOWN_MESSAGE = "enrollment outcome is unknown; the server may have redeemed the one-time code or replaced the Runner credential";

export class EnrollmentOutcomeUnknownError extends Error {
  public readonly outcomeUnknown = true;
  public constructor(detail = ENROLLMENT_OUTCOME_UNKNOWN_MESSAGE) {
    super(detail);
    this.name = "EnrollmentOutcomeUnknownError";
  }
}

/**
 * The Worker returns 409 before redeeming the code when another credential
 * mutation already owns the RunnerDO fence.  This is a deterministic conflict
 * rather than an uncertain redemption; callers must preserve the current
 * profile so a concurrent successful enrollment cannot be deleted locally.
 */
export class EnrollmentConflictError extends Error {
  public constructor(detail = "enrollment is already in progress for this Runner; wait for it to finish and retry") {
    super(detail);
    this.name = "EnrollmentConflictError";
  }
}

export function isEnrollmentOutcomeUnknown(error: unknown): error is EnrollmentOutcomeUnknownError {
  return error instanceof EnrollmentOutcomeUnknownError
    || (typeof error === "object" && error !== null && (error as { readonly outcomeUnknown?: unknown }).outcomeUnknown === true);
}

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
  let response: Response;
  try {
    response = await request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_code: options.code,
        runner_public_info: { platform: process.platform, architecture: process.arch, hostname: hostname().slice(0, 256), runner_version: RUNNER_VERSION, protocol_version: PROTOCOL_CURRENT_VERSION },
      }),
    });
  } catch {
    throw new EnrollmentOutcomeUnknownError(`enrollment request failed; ${ENROLLMENT_OUTCOME_UNKNOWN_MESSAGE}`);
  }
  if (!response.ok) {
    // The Worker uses 503 for a fenced/possibly committed mutation.  Keep
    // ordinary client-side 4xx responses actionable without deleting a still
    // usable profile, but fail closed for every server/transport uncertainty.
    if (response.status === 409) {
      throw new EnrollmentConflictError();
    }
    if (enrollmentResponseOutcomeUnknown(response.status)) {
      throw new EnrollmentOutcomeUnknownError(`${ENROLLMENT_OUTCOME_UNKNOWN_MESSAGE} (enrollment failed with HTTP ${response.status})`);
    }
    throw new Error(`enrollment failed (${response.status})`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EnrollmentOutcomeUnknownError(`${ENROLLMENT_OUTCOME_UNKNOWN_MESSAGE}; the server returned an unreadable response`);
  }
  const enrolled = enrollmentResponse(body);
  if (enrolled === undefined) throw new EnrollmentOutcomeUnknownError(`${ENROLLMENT_OUTCOME_UNKNOWN_MESSAGE}; the server returned an invalid response`);
  // Enrollment represents a machine Runner. It intentionally never infers a local
  // workspace from process.cwd() (or from the legacy cwd option). Initial
  // enrollment therefore has zero workspaces; re-enrollment keeps explicitly
  // configured roots while replacing only connection credentials.
  let profile: RunnerProfile;
  try {
    profile = {
      version: 1,
      server_url: connectionUrl(enrolled.serverUrl),
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
  } catch {
    // A successful response means the remote credential is authoritative even
    // when URL validation or the local atomic write fails.  Never leave an old
    // profile behind in that case.
    throw new EnrollmentOutcomeUnknownError(`${ENROLLMENT_OUTCOME_UNKNOWN_MESSAGE}; the new local profile could not be saved`);
  }
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
function connectionUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("enrollment response has an invalid server URL"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("enrollment response has an unsafe server URL");
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:" && loopback) url.protocol = "ws:";
  else if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("enrollment response has an invalid server URL");
  if (url.protocol === "ws:" && !loopback) throw new Error("enrollment response requires wss:// except loopback development");
  return url.toString();
}
function enrollmentResponse(value: unknown): { readonly runnerId: string; readonly serverUrl: string; readonly token: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.runner_id !== "string" || !SAFE_ID.test(item.runner_id) || typeof item.server_url !== "string" || typeof item.token !== "string" || item.token.length < 16 || /\s/.test(item.token)) return undefined;
  return { runnerId: item.runner_id, serverUrl: item.server_url, token: item.token };
}

/**
 * Only an explicit, ordinary 4xx rejection is deterministic. Redirects,
 * malformed status values, server errors, and timeout/rate-limit/client-close
 * responses can be emitted after a request was processed, so callers must not
 * continue using a pre-enrollment credential for those outcomes.
 */
function enrollmentResponseOutcomeUnknown(status: number): boolean {
  if (!Number.isInteger(status) || status < 200 || status >= 600) return true;
  if ((status >= 300 && status < 400) || status >= 500) return true;
  return status === 408 || status === 425 || status === 429 || status === 499;
}
