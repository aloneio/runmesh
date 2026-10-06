/** Local maintenance v1 projections. Keep these fields readable by the installed
 * manager when Runner execution settings, task payloads or record formats evolve. */
export interface RunnerMaintenanceIdentity {
  readonly server_url: string;
  readonly runner_id: string;
  readonly token: string;
  readonly insecure_local?: boolean;
}

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const boundedString = (value: unknown, min: number, max: number): value is string => typeof value === "string" && value.length >= min && value.length <= max && !controlCharacters.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Credential identity is stable across profile revisions. Runtime configuration
 * is validated separately, so a broken workspace setting cannot disable repair. */
export function maintenanceIdentity(value: unknown): RunnerMaintenanceIdentity | undefined {
  if (!record(value) || !Number.isSafeInteger(value.version) || Number(value.version) < 1
    || !boundedString(value.server_url, 2, 2048) || !boundedString(value.runner_id, 1, 128)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.runner_id)
    || !boundedString(value.token, 16, 4096) || /\s/u.test(value.token)) return undefined;
  try {
    const url = new URL(value.server_url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.toString().length > 2048
      || !(url.protocol === "wss:" || url.protocol === "ws:" && loopback && value.insecure_local === true)) return undefined;
  } catch { return undefined; }
  return { server_url: value.server_url, runner_id: value.runner_id, token: value.token,
    ...(value.insecure_local === true ? { insecure_local: true } : {}) };
}

// The writer and maintenance reader share the durable metadata budget and ID
// contract; command payloads and recovery annotations are not updater inputs.
export const MAX_MAINTENANCE_METADATA_BYTES = 8 * 1024 * 1024;
export function safeMaintenanceJobId(value: string): boolean { return /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value); }
/** Durable v1 status semantics shared by ordinary writers and installed managers. */
export const MAINTENANCE_JOB_STATES = Object.freeze({
  queued: true, running: true, cancelling: true, unknown: true,
  cancelled: false, succeeded: false, failed: false, interrupted: false,
} as const);
export type MaintenanceJobStatus = keyof typeof MAINTENANCE_JOB_STATES;
export function isMaintenanceJobStatus(value: unknown): value is MaintenanceJobStatus {
  return typeof value === "string" && Object.hasOwn(MAINTENANCE_JOB_STATES, value);
}
export interface MaintenanceJobState { readonly active: boolean; }
export function maintenanceJobState(value: unknown, expectedJobId: string): MaintenanceJobState | undefined {
  if (!record(value) || !safeMaintenanceJobId(expectedJobId) || value.job_id !== expectedJobId
    || !Number.isSafeInteger(value.created_at_ms) || Number(value.created_at_ms) < 0
    || !Number.isSafeInteger(value.updated_at_ms) || Number(value.updated_at_ms) < 0
    || !isMaintenanceJobStatus(value.status)) return undefined;
  return { active: MAINTENANCE_JOB_STATES[value.status] };
}
