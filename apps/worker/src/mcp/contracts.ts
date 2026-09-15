import type { ActiveRunnerContext } from "../contracts/runner-selection.js";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { PolicyReadiness as RegistryPolicyReadiness } from "../contracts/runner-selection.js";
import type { RpcOperationState } from "@aloneio/runmesh-protocol";
import type { WorkerEnv } from "../platform/env.js";

export type McpAuth = AuthInfo & { token: string };

// Captured once per handler instance; never stored in shared Worker globals.
export type McpRequestEnv = WorkerEnv & { readonly mcpPrincipal: { readonly client_id: string; readonly secret_version: unknown } };

export type InspectResultKind = "list" | "search" | "stat" | "git_status" | "git_diff" | "git_log" | "git_show" | "git_blame";

export type ActiveSelection = {
  readonly runnerId: string;
  readonly context: ActiveRunnerContext & { readonly automatic_selection: boolean };
};

export type RunnerResultMode = "raw" | "job" | "logs" | "input" | "shell" | "read" | "edit" | "context" | "inspect:list" | "inspect:search" | "inspect:stat" | "inspect:git_status" | "inspect:git_diff" | "inspect:git_log" | "inspect:git_show" | "inspect:git_blame";

export type ActivePolicyReadiness = Omit<Extract<RegistryPolicyReadiness, { readonly ok: true }>, "lifecycle_id" | "session_id"> & {
  readonly lifecycle_id: string;
  readonly session_id: string;
};

export type SelectionCall = ToolSuccess | ToolFailure;

export type ActiveSelectionCall = { readonly ok: true; readonly value: ActiveSelection } | ToolFailure;

export type PermissionCheck = ToolFailure;

export type PermissionBit = "read" | "edit" | "shell" | "job_control";

type ToolSuccess = { readonly ok: true; readonly value: unknown };

export type ToolFailure = { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly hint: string; readonly details?: unknown; readonly failure_class?: string; readonly operation_state?: RpcOperationState; readonly retry_after_ms?: number; readonly next_action?: string } };

export type ToolCall = ToolSuccess | ToolFailure;

export type AuditReceipt = { readonly correlation_id: string; readonly audit_status: "recorded" | "degraded" | "unknown" | "disabled" };
