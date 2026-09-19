import type { RuntimeConfiguration } from "../runtime-config.js";

export interface WorkerEnv extends RuntimeConfiguration {
  /** Request-local browser admission; never a deployment binding or cached grant. */
  readonly adminSessionHash?: string;
  /** Optional independent metadata-only audit store; never an auth fallback. */
  HISTORY_DB?: D1Database;
  RUNMESH_AUDIT_BACKEND?: string;
  RUNMESH_JOB_HISTORY_BACKEND?: string;
  REGISTRY: DurableObjectNamespace;
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
