import { resolvePublicOrigin } from "./public-origin.js";
import { REVIEWED_RELEASE_VERSION } from "./generated-release.js";

/** Pure resolution: no database access, credential generation, or timers. */
export interface RuntimeConfiguration {
  HISTORY_DB?: unknown;
  RUNMESH_ENVIRONMENT?: string;
  WORKER_ID?: string;
  RUNMESH_PUBLIC_ORIGIN?: string;
  RUNMESH_SIGNED_RELEASE_AVAILABLE?: string;
  RUNMESH_AUDIT_BACKEND?: string;
  RUNMESH_JOB_HISTORY_BACKEND?: string;
  RUNMESH_TEST_MODE?: string;
  RUNMESH_DEPLOYMENT_BRANCH?: string;
  RUNMESH_DEPLOYMENT_COMMIT?: string;
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
}

export function resolveRuntimeConfiguration<T extends RuntimeConfiguration>(env: T, request?: Request): T {
  const environment = env.RUNMESH_ENVIRONMENT ??
    (env.WORKER_ID === "worker-development" ? "development" : env.WORKER_ID === "worker-test" || env.RUNMESH_TEST_MODE === "1" ? "test" : "production");
  const production = environment === "production" && env.RUNMESH_TEST_MODE !== "1";
  const backend = (environment !== "development" && environment !== "test") || env.HISTORY_DB !== undefined ? "d1" : "sqlite";
  let origin = env.RUNMESH_PUBLIC_ORIGIN;
  if (origin === undefined && request !== undefined && request.headers.has("host")) {
    try { origin = resolvePublicOrigin(request); } catch { /* Origin validation will fail closed. */ }
  }
  const tag = /^(main|dev):([a-f0-9]{40})$/.exec(env.CF_VERSION_METADATA?.tag ?? "");
  return {
    ...env,
    WORKER_ID: env.WORKER_ID ?? (environment === "production" ? "worker-production" : environment === "development" ? "worker-development" : "worker-test"),
    // An explicit empty override remains the emergency disable switch.
    RUNMESH_SIGNED_RELEASE_AVAILABLE: env.RUNMESH_SIGNED_RELEASE_AVAILABLE ?? (production ? REVIEWED_RELEASE_VERSION : ""),
    ...(origin === undefined ? {} : { RUNMESH_PUBLIC_ORIGIN: origin }),
    // Explicit d1 without its binding must report unavailable, never fall back.
    RUNMESH_AUDIT_BACKEND: env.RUNMESH_AUDIT_BACKEND ?? backend,
    RUNMESH_JOB_HISTORY_BACKEND: env.RUNMESH_JOB_HISTORY_BACKEND ?? backend,
    ...(env.CF_VERSION_METADATA === undefined ? {} : { RUNMESH_DEPLOYMENT_BRANCH: tag?.[1], RUNMESH_DEPLOYMENT_COMMIT: tag?.[2] }),
  };
}
