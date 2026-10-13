import { RunnerUpdateClaimSchema, RunnerUpdateDrainProofSchema, RunnerUpdateResponseSchema, RunnerUpdateStatusSchema } from "@aloneio/runmesh-protocol";
import type { RunnerMaintenanceIdentity } from "../maintenance-contract.js";
import { retryAfterDelayMs } from "../backoff.js";
import { MaintenanceHttpError } from "./contracts.js";
import type { CloudMaintenancePort, CloudUpdateObservation, CloudUpdateState, UpdateErrorCode, UpdateOwner } from "./contracts.js";

export function maintenanceEndpoint(profile: RunnerMaintenanceIdentity): URL {
  const url = new URL(profile.server_url);
  const path = url.pathname.replace(/\/+$/, "");
  if (url.username || url.password || url.search || url.hash || !path.endsWith("/runner/connect")) throw new Error("invalid maintenance origin");
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:" && profile.insecure_local === true && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.protocol = "http:";
  else throw new Error("maintenance requires authenticated HTTPS");
  url.pathname = path.slice(0, -"/runner/connect".length) + `/runner/${encodeURIComponent(profile.runner_id)}/update`;
  return url;
}

/** The existing protected profile is reloaded for every request, so credential
 * rotation does not create a second persistent secret or require agent reinstall. */
export function createCloudMaintenance(options: { readonly profile: () => Promise<RunnerMaintenanceIdentity>; readonly fetch?: typeof fetch; readonly signal?: AbortSignal }): CloudMaintenancePort {
  const fetchImpl = options.fetch ?? fetch;
  const request = async (suffix: string, body?: unknown): Promise<CloudUpdateObservation> => {
    const profile = await options.profile(); const url = maintenanceEndpoint(profile); url.pathname += suffix;
    const deadline = AbortSignal.timeout(10_000);
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
    signal.throwIfAborted();
    let stop!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason ?? new Error("maintenance request aborted"));
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
    let response: Response;
    try {
      response = await Promise.race([fetchImpl(url, { method: body === undefined ? "GET" : "POST", redirect: "error", credentials: "omit", cache: "no-store", signal,
        headers: { authorization: `Bearer ${profile.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), interrupted]) as Response;
    } finally { signal.removeEventListener("abort", stop); }
    // A custom transport may ignore AbortSignal and resolve after the
    // maintenance request has already expired. The response is orphaned at
    // that point; do not inspect or cancel its body after the lifecycle ends.
    if (signal.aborted) throw signal.reason ?? new Error("maintenance request aborted");
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new MaintenanceHttpError(response.status, retryAfterDelayMs(response.headers.get("retry-after") ?? undefined)); }
    const limit = 32 * 1024;
    const declared = response.headers.get("content-length");
    if (response.body === null || (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit))) { void response.body?.cancel().catch(() => undefined); throw new Error("invalid maintenance response"); }
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let total = 0;
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    const abort = () => { void reader.cancel().catch(() => undefined); };
    const release = (): void => { try { reader.releaseLock(); } catch { /* a read may still be pending */ } };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (let chunks = 0; ; chunks++) {
        if (chunks >= 256) throw new Error("invalid maintenance response");
        const read = reader.read();
        pendingRead = read;
        let part: ReadableStreamReadResult<Uint8Array>;
        try { part = await read; }
        finally { if (pendingRead === read) pendingRead = undefined; }
        signal.throwIfAborted();
        if (part.done) break;
        total += part.value.byteLength; if (total > limit) throw new Error("invalid maintenance response"); parts.push(part.value);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      void reader.cancel().catch(() => undefined);
      const read = pendingRead;
      if (read !== undefined) void read.then(release, release);
      else release();
    }
    return RunnerUpdateResponseSchema.parse(JSON.parse(Buffer.concat(parts, total).toString("utf8")));
  };
  return {
    poll: () => request(""),
    claim: (owner: UpdateOwner) => request("/claim", RunnerUpdateClaimSchema.parse(owner)),
    proveStopped: (owner: UpdateOwner) => request("/drain-proof", RunnerUpdateDrainProofSchema.parse({ ...owner, old_process_stopped: true })),
    report: (owner: UpdateOwner, state: Exclude<CloudUpdateState, "queued">, details: { readonly error_code?: UpdateErrorCode; readonly observed_version?: string } = {}) => request("/status", RunnerUpdateStatusSchema.parse({ ...owner, state, ...details })),
  };
}
