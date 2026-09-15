import { activeRunnerTool } from "../dispatch.js";
import { isRedactionTruncationEnvelope } from "../results/envelope.js";
import { isToolSuccessResult } from "../results/envelope.js";
import { MCP_RPC_ACTIONS } from "../actions.js";
import type { McpRequestEnv } from "../contracts.js";
import { safeShellResult } from "../results/jobs.js";
import { ShellInputSchema } from "../catalog.js";
import { success } from "../results/envelope.js";
import { z } from "zod";

export async function shellTool(env: McpRequestEnv, clientId: string, params: z.output<typeof ShellInputSchema>): Promise<unknown> {
  const invocation = { workspace_id: params.workspace_id, command: params.command, shell: true, created_by_client_id: clientId, ...(params.queue === undefined ? {} : {queue:params.queue}), ...(params.request_id === undefined ? {} : { request_id: params.request_id }) };
  // Background starts return a Runner JobRecord.  Keep the MCP response on
  // the stable job-metadata allow-list; command/cwd/PID/process identity are
  // Runner-internal and must not cross this boundary.
  if (params.background === true) return activeRunnerTool(env, clientId, MCP_RPC_ACTIONS.shell.start, invocation, "shell", "job");
  const result = await activeRunnerTool(env, clientId, MCP_RPC_ACTIONS.shell.run, { ...invocation, ...(params.wait_ms === undefined ? {} : { wait_ms: params.wait_ms }) }, "shell", "shell");
  return normalizeShellResult(result);
}

function normalizeShellResult(result: unknown): unknown {
  if (!isToolSuccessResult(result)) return result;
  const value = result.structuredContent;
  // `success()` may already have returned its bounded truncation envelope.
  // Preserve that explicit signal rather than replacing it with an empty
  // projection; the serialized data has already passed redaction.
  if (isRedactionTruncationEnvelope(value)) return result;
  const projected = safeShellResult(value);
  // activeRunnerTool adds this local receipt after projecting the untrusted
  // Runner response. Normalization must not discard the audit outcome.
  if (typeof value.correlation_id === "string" && /^call-[A-Za-z0-9-]+$/.test(value.correlation_id)
    && ["recorded", "degraded", "unknown", "disabled"].includes(String(value.audit_status))) {
    projected.correlation_id = value.correlation_id;
    projected.audit_status = value.audit_status;
  }
  return success(projected);
}
