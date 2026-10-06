import { z } from "zod";
import { exactRunnerRelease } from "./release-trust.js";

/** Independent HTTPS control contract, deliberately outside the Runner wire protocol. */
export const RunnerExactVersionSchema = z.string().max(64).refine(value => { try { exactRunnerRelease(value); return true; } catch { return false; } });
const UpdateIdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const RunnerUpdateStateSchema = z.enum(["queued", "verifying", "draining", "installing", "checking", "succeeded", "rolled_back", "failed"]);
export const RunnerUpdateErrorCodeSchema = z.enum(["verification_failed", "busy_local_jobs", "service_stop_failed", "activation_failed", "rollback_failed", "invalid_installation", "local_state_invalid"]);
export const RunnerUpdateOperationSchema = z.object({
  operation_id: UpdateIdentifierSchema,
  lifecycle_id: UpdateIdentifierSchema,
  target_version: RunnerExactVersionSchema,
  target_channel: z.enum(["stable", "dev"]),
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  original_version: z.string().max(64).nullable(),
  manager_id: UpdateIdentifierSchema.nullable(),
  state: RunnerUpdateStateSchema,
  error_code: RunnerUpdateErrorCodeSchema.nullable(),
  created_at_ms: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
}).strict();
export const RunnerUpdateClaimSchema = z.object({
  operation_id: UpdateIdentifierSchema,
  lifecycle_id: UpdateIdentifierSchema,
  manager_id: UpdateIdentifierSchema,
}).strict();
export const RunnerUpdateStatusSchema = RunnerUpdateClaimSchema.extend({
  state: RunnerUpdateStateSchema.exclude(["queued"]),
  error_code: RunnerUpdateErrorCodeSchema.optional(),
  observed_version: z.string().max(64).optional(),
}).strict();
export const RunnerUpdateDrainProofSchema = RunnerUpdateClaimSchema.extend({ old_process_stopped: z.literal(true) }).strict();
export const RunnerUpdateResponseSchema = z.object({
  operation: RunnerUpdateOperationSchema.nullable(),
  cloud_drained: z.boolean(),
  cloud_uncertain: z.boolean().default(false),
  observed_version: z.string().max(64).nullable(),
  observed_new_session: z.boolean(),
}).strict();
export type RunnerUpdateState = z.infer<typeof RunnerUpdateStateSchema>;
export type RunnerUpdateErrorCode = z.infer<typeof RunnerUpdateErrorCodeSchema>;
export type RunnerUpdateOperation = z.infer<typeof RunnerUpdateOperationSchema>;
export type RunnerUpdateClaim = z.infer<typeof RunnerUpdateClaimSchema>;
export type RunnerUpdateStatus = z.infer<typeof RunnerUpdateStatusSchema>;
export type RunnerUpdateDrainProof = z.infer<typeof RunnerUpdateDrainProofSchema>;
export type RunnerUpdateResponse = z.infer<typeof RunnerUpdateResponseSchema>;
export function isTerminalRunnerUpdate(state: RunnerUpdateState): boolean {
  return state === "succeeded" || state === "rolled_back" || state === "failed";
}
