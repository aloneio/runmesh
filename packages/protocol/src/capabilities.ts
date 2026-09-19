import { z } from "zod";
import { RPC_OPERATION_METHODS } from "./operations.js";

/** Optional env.info addition: implementation evidence, never a grant. Old
 * peers omit it. Strict, bounded parsing must not turn omission into support. */
export const RunnerCapabilityReportSchema = z.object({
  schema_version: z.literal(1),
  runner_version: z.string().min(1).max(64).regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
  operation_contract_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  supported_rpc_methods: z.array(z.enum(RPC_OPERATION_METHODS)).max(RPC_OPERATION_METHODS.length)
    .refine(methods => new Set(methods).size === methods.length, "Duplicate method"),
  features: z.object({ job_queue: z.number().int().min(0).max(1), job_history: z.number().int().min(0).max(1), context_record: z.number().int().min(1).max(2) }).strict(),
  max_concurrent_jobs: z.number().int().min(1).max(1000),
}).strict();
