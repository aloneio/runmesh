import type { RunnerRoute } from "./request.js";
import { projectActiveWorkspaces, projectPolicyVersions, projectPolicyRevision } from "../route-projections.js";
import type { PolicyReadiness } from "../../contracts/runner-selection.js";
import type { RunnerPolicy } from "@aloneio/runmesh-protocol";
import type { PolicyAcknowledgementResult, RunnerRecord, InternalInput } from "../records.js";
import { parseTransportIdentity } from "../values.js";
export interface RunnerPolicyReadPorts {
  getActivePolicySnapshot(runnerId: string): RunnerPolicy | undefined;
  getSnapshotAuthorization(runnerId: string): {
    readonly ok: true;
    readonly revision: number;
    readonly checksum: string;
  } | {
    readonly ok: false;
    readonly code: "policy_pending" | "stale_policy";
    readonly reason: string;
  };
  getPolicyReadiness(runnerId: string): PolicyReadiness;
  getRunner(runnerId: string): RunnerRecord | undefined;
  policyAcknowledgementFromInput(runnerId: string, input: InternalInput, nowMs: number): PolicyAcknowledgementResult | undefined;
  desiredPolicy(runnerId: string): RunnerPolicy | undefined;
  listPolicyVersions(runnerId: string): Array<{
    runner_id: string;
    revision: number;
    checksum: string;
    policy_json: string;
    status: string;
    created_at_ms: number;
    acknowledged_at_ms: number | null;
    validation_summary_json: string | null;
    source_revision: number | null;
    mutation_id: string | null;
  }>;
  policyMutationId(runnerId: string, revision: number): string | null;
}

/** Admitted requests only; authority remains with synchronous Registry operations. */
export function createRunnerPolicyReadRoutes(ports: RunnerPolicyReadPorts): RunnerRoute {
  return ({
    method,
    runnerId,
    action,
    itemId,
    input,
    nowMs: admittedAtMs
  }) => {
    if (method === "GET" && action === "active-policy" && itemId === undefined) {
      const policy = ports.getActivePolicySnapshot(runnerId);
      return policy === undefined ? new Response("not found", {
        status: 404
      }) : Response.json(policy);
    }
    if (method === "GET" && action === "active-workspaces" && itemId === undefined) {
      const policy = ports.getActivePolicySnapshot(runnerId);
      if (policy === undefined) return new Response("not found", {
        status: 404
      });
      return Response.json(projectActiveWorkspaces(runnerId, policy));
    }
    if (method === "GET" && action === "snapshot-authorization" && itemId === undefined) return Response.json(ports.getSnapshotAuthorization(runnerId));
    if (method === "GET" && action === "policy-readiness" && itemId === undefined) {
      const readiness = ports.getPolicyReadiness(runnerId);
      const runner = ports.getRunner(runnerId);
      const desiredPolicyMutationId = runner === undefined ? null : ports.policyMutationId(runnerId, runner.desired_policy_revision) ?? null;
      return Response.json({
        ...readiness,
        desired_policy_mutation_id: desiredPolicyMutationId
      });
    }
    if (method === "POST" && action === "policy-ack") {
      if (!parseTransportIdentity(input).valid) return Response.json({
        error: "invalid policy acknowledgement identity"
      }, {
        status: 400
      });
      const ack = ports.policyAcknowledgementFromInput(runnerId, input, admittedAtMs);
      if (ack === undefined) return Response.json({
        error: "invalid policy acknowledgement"
      }, {
        status: 409
      });
      return Response.json({
        ack_result: ack
      });
    }
    if (method === "GET" && action === "desired-policy" && itemId === undefined) {
      const policy = ports.desiredPolicy(runnerId);
      const mutationId = policy === undefined ? undefined : ports.policyMutationId(runnerId, policy.revision);
      return policy === undefined ? new Response("not found", {
        status: 404
      }) : Response.json({
        ...policy,
        mutation_id: mutationId ?? null
      });
    }
    if (method === "GET" && action === "policy-versions" && itemId === undefined) return Response.json(projectPolicyVersions(runnerId, ports.listPolicyVersions(runnerId)));
    if (method === "GET" && action === "policy-revision" && itemId === undefined) {
      const runner = ports.getRunner(runnerId);
      if (runner === undefined) return new Response("not found", {
        status: 404
      });
      const mutationId = ports.policyMutationId(runnerId, runner.desired_policy_revision);
      return Response.json(projectPolicyRevision(runner, mutationId));
    }
    return undefined;
  };
}
