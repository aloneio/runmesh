import { RunnerCapabilityReportSchema, RPC_OPERATION_CONTRACT } from "@aloneio/runmesh-protocol";
import { MCP_ACTION_REQUIREMENTS } from "./actions.js";
import { MCP_CATALOG_SUMMARY } from "./catalog-contract.js";

type Permissions = Readonly<{ read: boolean; edit: boolean; shell: boolean; job_control: boolean }>;

/** Pure allow-list projection of the existing env.info response. The peer's
 * implementation report is evidence, not proof of OS access or permission. */
export function capabilityDiagnostics(value: unknown, scopes: readonly string[], permissions: Permissions | undefined) {
  const parsed = RunnerCapabilityReportSchema.safeParse(value);
  const report = parsed.success ? parsed.data : null;
  const support = report === null ? null : new Set<string>(report.supported_rpc_methods);
  return {
    schema_version: 1, source: report === null ? "unavailable" : "live_env_info",
    report_state: report === null ? (value === undefined ? "not_reported" : "invalid") : "reported",
    evidence_scope: "implementation_only", runner: report,
    contract_match: report === null ? null : report.operation_contract_sha256 === RPC_OPERATION_CONTRACT.sha256,
    worker_catalog: MCP_CATALOG_SUMMARY,
    // This server cannot observe a host's cached tools/list. Never label it
    // synchronized just because the server's own catalog is well-formed.
    host_catalog_state: "not_observed",
    actions: MCP_ACTION_REQUIREMENTS.map(({ tool, action, method, scope, permission, job }) => ({
      tool, action, method, required_scope: scope, required_permission: permission,
      runner_support: support === null ? "unknown" : support.has(method) ? "supported" : "unsupported",
      permission_snapshot: !scopes.includes(scope) ? "denied" : permissions === undefined ? "unknown" : permissions[permission] ? "permitted" : "denied",
      requires_job_check: job, requires_final_authorization: true,
    })),
  };
}
