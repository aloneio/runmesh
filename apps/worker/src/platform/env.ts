import type { RuntimeConfiguration } from "../runtime-config.js";

export interface WorkerEnv extends RuntimeConfiguration {
  /** Request-local browser admission; never a deployment binding or cached grant. */
  readonly adminSessionHash?: string;
  /** Optional independent metadata-only audit store; never an auth fallback. */
  HISTORY_DB?: D1Database;
  RUNMESH_AUDIT_BACKEND?: string;
  RUNMESH_JOB_HISTORY_BACKEND?: string;
  REGISTRY: DurableObjectNamespace;
  /** Optional central feature owner; absent means no central runtime access. */
  CAPABILITIES?: DurableObjectNamespace;
  /** Explicit opt-in; a central binding alone does not publish Skill content. */
  CENTRAL_SKILLS_ENABLED?: string;
  /** Optional durable rate budgets, cooldown and metadata-only receipts. */
  CENTRAL_GOVERNANCE_ENABLED?: string;
  /** Small approved direct catalogs; large views retain discovery/call tools. */
  CENTRAL_DIRECT_TOOLS_ENABLED?: string;
  /** Independent versioned encryption keyring; never stored in SQLite or returned. */
  CENTRAL_VAULT_KEYRING?: string;
  RUNNER: DurableObjectNamespace;
  WORKER_ID?: string;
  RUNMESH_DEPLOYMENT_BRANCH?: string;
  RUNMESH_DEPLOYMENT_COMMIT?: string;
  ADMIN_TOKEN?: string;
  /** Long-lived Runner token verifier pepper; at least 32 random characters. */
  RUNNER_TOKEN_PEPPER?: string;
  INTERNAL_CONTROL_SECRET?: string;
  RUNMESH_SIGNED_RELEASE_AVAILABLE?: string;
  /** Canonical external HTTPS origin used in hosted installer commands. */
  RUNMESH_PUBLIC_ORIGIN?: string;
  /** Test-harness-only switch; never configured by a deployment. */
  RUNMESH_TEST_MODE?: string;
  /** Static assets served by the Worker asset binding. */
  ASSETS?: Fetcher;
}
