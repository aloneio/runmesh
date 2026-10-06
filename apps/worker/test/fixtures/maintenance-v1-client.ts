import { z } from "zod";

/**
 * Frozen client contract from 0.1.8-dev.45 (e3cf4bae5f96c96d3fd27dcf7f9f45321b8c9eb8).
 * Copied from packages/protocol/src/runner-update.ts and the HTTP request behavior
 * in apps/runner/src/updates/cloud.ts. Deliberately imports no current Runmesh code.
 * Keep this fixture unchanged when adding a new maintenance contract: installed
 * managers keep this parser even after their Runner executable has been replaced.
 * The test adapter omits Node stream/time-limit plumbing, not the wire contract.
 * workerd uses manual redirects plus the non-2xx rejection below in place of the
 * Node client's redirect:error setting, which workerd does not implement.
 */
const exactVersion = z.string().max(64).refine(value => /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-dev\.(0|[1-9]\d{0,19}))?$/u.test(value));
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const maintenanceV1State = z.enum(["queued", "verifying", "draining", "installing", "checking", "succeeded", "rolled_back", "failed"]);
export const maintenanceV1Error = z.enum(["verification_failed", "busy_local_jobs", "service_stop_failed", "activation_failed", "rollback_failed", "invalid_installation", "local_state_invalid"]);
export const maintenanceV1Operation = z.object({
  operation_id: identifier,
  lifecycle_id: identifier,
  target_version: exactVersion,
  target_channel: z.enum(["stable", "dev"]),
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  original_version: z.string().max(64).nullable(),
  manager_id: identifier.nullable(),
  state: maintenanceV1State,
  error_code: maintenanceV1Error.nullable(),
  created_at_ms: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
}).strict();
export const maintenanceV1Claim = z.object({ operation_id: identifier, lifecycle_id: identifier, manager_id: identifier }).strict();
export const maintenanceV1Status = maintenanceV1Claim.extend({
  state: maintenanceV1State.exclude(["queued"]),
  error_code: maintenanceV1Error.optional(),
  observed_version: z.string().max(64).optional(),
}).strict();
export const maintenanceV1DrainProof = maintenanceV1Claim.extend({ old_process_stopped: z.literal(true) }).strict();
export const maintenanceV1Response = z.object({
  operation: maintenanceV1Operation.nullable(),
  cloud_drained: z.boolean(),
  cloud_uncertain: z.boolean().default(false),
  observed_version: z.string().max(64).nullable(),
  observed_new_session: z.boolean(),
}).strict();
export type MaintenanceV1Operation = z.infer<typeof maintenanceV1Operation>;
type Owner = z.infer<typeof maintenanceV1Claim>;

export function maintenanceV1Client(options: { runnerId: string; token: () => string; fetch: (request: Request) => Promise<Response> }) {
  const request = async (suffix: string, body?: unknown) => {
    const response = await options.fetch(new Request(`https://worker.test/runner/${encodeURIComponent(options.runnerId)}/update${suffix}`, {
      method: body === undefined ? "GET" : "POST", redirect: "manual",
      headers: { authorization: `Bearer ${options.token()}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    if (!response.ok) throw new Error(`maintenance_http_${response.status}`);
    if (response.headers.get("cache-control") !== "no-store") throw new Error("maintenance response must not be cached");
    return maintenanceV1Response.parse(await response.json());
  };
  return {
    poll: () => request(""),
    claim: (owner: Owner) => request("/claim", maintenanceV1Claim.parse(owner)),
    proveStopped: (owner: Owner) => request("/drain-proof", maintenanceV1DrainProof.parse({ ...owner, old_process_stopped: true })),
    report: (owner: Owner, state: Exclude<z.infer<typeof maintenanceV1State>, "queued">, details: { error_code?: z.infer<typeof maintenanceV1Error>; observed_version?: string } = {}) => request("/status", maintenanceV1Status.parse({ ...owner, state, ...details })),
  };
}
