import { z } from "zod";
import { ContextStorageReportSchema, ContextPruneReportSchema } from "@aloneio/runmesh-protocol";
import { MCP_RPC_ACTIONS } from "./actions.js";
import { TOOL_OUTPUT_SCHEMAS, PUBLIC_RESULT_METADATA, JobMetadataOutputSchema, LogOutputSchema, InspectOutputSchema, EditOutputSchema, ContextOutputSchema } from "./output-contracts.js";

const metadata = PUBLIC_RESULT_METADATA;
type Fields = z.ZodRawShape;
function pick<S extends Fields, K extends keyof S>(schema: z.ZodObject<S>, keys: readonly K[]): Pick<S, K> {
  return Object.fromEntries(keys.map(key => [key, schema.shape[key]])) as Pick<S, K>;
}
function result<S extends Fields>(shape: S) { return z.object({ ...metadata, ...shape }).strict(); }
const i = InspectOutputSchema.shape;
const j = JobMetadataOutputSchema.shape;
const c = ContextOutputSchema.shape;
const job = result({ ...j, job_id: j.job_id.unwrap(), status: j.status.unwrap(), source: z.enum(["runner_live", "registry_snapshot"]).optional(), runner_state: z.literal("offline").optional() });
const identifiedContext = c.context.unwrap().unwrap().required({ context_id: true });
const contextRecord = result({ ...pick(ContextOutputSchema, ["workspace_id", "state", "context", "deduplicated"]), context: identifiedContext });

/** Closed per-action variants are separate from the stable aggregate public
 * tool schema. Every action in the RPC map must have an output validator. */
export const ACTION_OUTPUT_CONTRACTS = {
  inspect: {
    list: result({ ...pick(InspectOutputSchema, ["workspace_id", "path", "entries", "next_cursor"]), entries: i.entries.unwrap().options[0] }),
    search: result({ ...pick(InspectOutputSchema, ["workspace_id", "query", "mode", "case_sensitive", "engine", "snapshot_id", "results", "next_cursor", "next_snapshot_cursor", "truncated_reason", "scanned", "returned_bytes"]), results: i.results.unwrap() }),
    stat: result({ ...pick(InspectOutputSchema, ["workspace_id", "path", "type", "size", "modified_at_ms", "encoding", "binary"]), type: i.type.unwrap() }),
    git_status: result({ ...pick(InspectOutputSchema, ["workspace_id", "path", "entries", "branch", "ahead", "behind", "output_bytes"]), entries: i.entries.unwrap().options[1] }),
    git_diff: result({ ...pick(InspectOutputSchema, ["workspace_id", "path", "diff", "staged", "encoding", "bytes"]), diff: i.diff.unwrap() }),
    git_log: result({ ...pick(InspectOutputSchema, ["workspace_id", "path", "commits", "limit"]), commits: i.commits.unwrap() }),
    git_show: result({ ...pick(InspectOutputSchema, ["workspace_id", "path", "revision", "output", "encoding", "bytes"]), output: i.output.unwrap() }),
    git_blame: result({ ...pick(InspectOutputSchema, ["workspace_id", "path", "start_line", "end_line", "output", "encoding", "bytes"]), output: i.output.unwrap() }),
    diagnostics: result({ ...pick(InspectOutputSchema, ["workspace_id", "observed_at_ms", "permissions", "checks", "capabilities", "shell"]), observed_at_ms: i.observed_at_ms.unwrap(), permissions: i.permissions.unwrap(), checks: i.checks.unwrap() }),
  } satisfies Record<keyof typeof MCP_RPC_ACTIONS.inspect, z.ZodType>,
  job: {
    list: TOOL_OUTPUT_SCHEMAS.job.pick({ runner_id: true, source: true, runner_state: true }).extend({ ...metadata, jobs: z.array(JobMetadataOutputSchema.required({ job_id: true, status: true })).max(1000) }),
    get: job, cancel: job,
    logs: result(LogOutputSchema.shape).refine(value => value.available === false ? value.error?.code === "log_unavailable" : typeof value.data === "string" && typeof value.offset === "number" && value.next_cursor !== undefined),
    input: TOOL_OUTPUT_SCHEMAS.job.pick({ accepted: true, eof: true }).extend(metadata).required({ accepted: true }),
  } satisfies Record<keyof typeof MCP_RPC_ACTIONS.job, z.ZodType>,
  context: {
    bootstrap: contextRecord.extend({ context: identifiedContext.nullable() }).refine(value => value.context !== null || value.state === "missing"),
    read: contextRecord, checkpoint: contextRecord,
    search: result({ ...pick(ContextOutputSchema, ["workspace_id", "state", "query", "next_cursor", "results", "scanned_records"]), results: z.array(c.results.unwrap().element.required({ context_id: true })).max(50) }),
    rebuild: result({ ...pick(ContextOutputSchema, ["workspace_id", "rebuilt", "records", "scanned_files", "scanned_bytes", "scanned_records", "rebuilt_at_ms"]), rebuilt: z.literal(true), records: c.records.unwrap() }),
    storage: ContextStorageReportSchema.extend(metadata),
    prune: ContextPruneReportSchema.extend(metadata),
  } satisfies Record<keyof typeof MCP_RPC_ACTIONS.context, z.ZodType>,
  edit: {
    preview: EditOutputSchema.required({ preview_id: true, previews: true }),
    apply: EditOutputSchema.refine(value => value.changed_paths !== undefined || value.operations !== undefined),
  } satisfies Record<keyof typeof MCP_RPC_ACTIONS.edit, z.ZodType>,
  shell: {
    start: TOOL_OUTPUT_SCHEMAS.shell.required({ job_id: true, status: true }),
    run: TOOL_OUTPUT_SCHEMAS.shell.required({ job_id: true, status: true }),
  } satisfies Record<keyof typeof MCP_RPC_ACTIONS.shell, z.ZodType>,
} as const;

const SIMPLE_OUTPUT_CONTRACTS = {
  runner_list: TOOL_OUTPUT_SCHEMAS.runner_list.required({ runners: true }),
  runner_current: TOOL_OUTPUT_SCHEMAS.runner_current.required({ active_runner_id: true, active_runner_updated_at_ms: true, active_runner: true }),
  runner_select: TOOL_OUTPUT_SCHEMAS.runner_select.required({ active_runner_id: true, active_runner_updated_at_ms: true, active_runner: true, changed: true }),
  workspace_list: TOOL_OUTPUT_SCHEMAS.workspace_list.required({ workspaces: true }),
  read: TOOL_OUTPUT_SCHEMAS.read.required({ data: true, offset: true, next_cursor: true }),
} satisfies Record<Exclude<keyof typeof TOOL_OUTPUT_SCHEMAS, keyof typeof ACTION_OUTPUT_CONTRACTS>, z.ZodType>;

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** No transformation/coercion; existing projectors own redaction. A valid
 * bounded truncation envelope remains explicit, never an empty success. */
export function validateToolOutput(name: keyof typeof TOOL_OUTPUT_SCHEMAS, input: unknown, value: unknown): boolean {
  if (!object(value) || !TOOL_OUTPUT_SCHEMAS[name].safeParse(value).success) return false;
  if (value.truncated === true && typeof value.data === "string" && typeof value.recovery_hint === "string" && Object.keys(value).every(key => Object.hasOwn(metadata, key))) return true;
  if (Object.hasOwn(SIMPLE_OUTPUT_CONTRACTS, name)) return SIMPLE_OUTPUT_CONTRACTS[name as keyof typeof SIMPLE_OUTPUT_CONTRACTS].safeParse(value).success;
  if (!object(input)) return false;
  const action = name === "shell" ? input.background === true ? "start" : "run" : name === "edit" ? input.preview === true ? "preview" : "apply" : input.action;
  const variants = ACTION_OUTPUT_CONTRACTS[name as keyof typeof ACTION_OUTPUT_CONTRACTS];
  if (typeof action !== "string" || !Object.hasOwn(variants, action)) return false;
  return (variants as Readonly<Record<string, z.ZodType>>)[action]!.safeParse(value).success;
}
