import type { PermissionSet, RunnerPolicy, RunnerPolicyWorkspace } from "./schema.js";

import { canonicalJson, sha256Hex } from "./hash.js";
export { canonicalJson, sha256Hex } from "./hash.js";

export interface RunnerPolicyChecksumInput {
  readonly schema_version: 1;
  readonly runner_id: string;
  readonly revision: number;
  readonly runner_permissions: PermissionSet;
  readonly workspaces: readonly RunnerPolicyWorkspace[];
}

export function policyWithoutChecksum(policy: RunnerPolicy): RunnerPolicyChecksumInput {
  return {
    schema_version: policy.schema_version,
    runner_id: policy.runner_id,
    revision: policy.revision,
    runner_permissions: policy.runner_permissions,
    workspaces: policy.workspaces,
  };
}

export function runnerPolicyChecksum(input: RunnerPolicyChecksumInput): string {
  return sha256Hex(canonicalJson(input));
}
