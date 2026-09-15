/** Source-only dependency policy; tooling/test dependencies are not runtime layers. */
export const SOURCE_ROOTS = ["apps/worker/src", "apps/runner/src", "packages/protocol/src"];
export const SOURCE_PACKAGES = {
  "@aloneio/runmesh-protocol": "packages/protocol/src/index.ts",
  "@aloneio/runmesh-runner": "apps/runner/src/index.ts",
  "@aloneio/runmesh-worker": "apps/worker/src/index.ts",
};
export const MISSING_GENERATED = new Set(["apps/worker/src/generated-provenance.ts"]);
export function layer(path) {
  return path.startsWith("packages/protocol/src/") ? "protocol"
    : path.startsWith("apps/worker/src/") ? "worker"
    : path.startsWith("apps/runner/src/") ? "runner" : "outside";
}
const pureRunner = /^(?:apps\/runner\/src\/jobs\/(?:records|values|recovery)|apps\/runner\/src\/context\/(?:model|retention-plan|storage-types))\.[jt]s$/u;
/** Pure record/planning modules may hash data, but may not acquire platform I/O. */
export function specifierProblem(from, specifier, typeOnly) {
  if (pureRunner.test(from) && /^(?:node:|fs(?:\/|$)|child_process$|process$|timers(?:\/|$)|worker_threads$|net$|http$|https$)/u.test(specifier)
    && !["node:crypto", "crypto"].includes(specifier)) return "Runner record and planning modules must not access filesystem, processes or timers";
  if (/^apps\/runner\/src\/(?:jobs|context)\/ports\.[jt]s$/u.test(from) && specifier.startsWith("node:") && !typeOnly) return "Runner ports may reference platform types but not load platform implementations";
  return undefined;
}
export function dependencyProblem(from, to) {
  const owner = layer(from), target = layer(to);
  if (target === "outside") return "source dependency leaves the application/protocol boundary";
  if (owner === "protocol" && target !== "protocol") return "protocol must not depend on an application";
  if (owner !== "protocol" && target !== "protocol" && target !== owner) return "Worker and Runner must not depend on one another";
  if (/^apps\/runner\/src\/(?:jobs|context)\//u.test(from)) {
    if (/^apps\/runner\/src\/(?:jobs|context-store|runtime|connection|cli|index|service|profile)\.[jt]s$/u.test(to)) return "Runner internals must not import their facade, transport or service entrypoints";
    if (pureRunner.test(from) && target === "runner" && !pureRunner.test(to) && !/^apps\/runner\/src\/(?:errors|config)\.[jt]s$/u.test(to)) return "Runner record and planning modules must not depend on concrete I/O adapters";
    if (/\/(?:jobs|context)\/ports\.[jt]s$/u.test(from) && target === "runner" && !pureRunner.test(to)) return "Runner ports must not depend on concrete adapters";
    if (/\/jobs\/logs\.[jt]s$/u.test(from) && /\/jobs\/(?:process|storage)\.[jt]s$/u.test(to)) return "Job log reading uses narrow ports, not process or record-storage implementations";
  }
  if (from.startsWith("apps/worker/src/registry/")) {
    if (/^apps\/worker\/src\/(?:registry|runner-do|index|external-audit|job-history-store)\.[jt]s$/u.test(to)
      || /^apps\/worker\/src\/(?:mcp|ui)\//u.test(to)) return "Registry domains must not depend on concrete DO, HTTP/UI or remote history adapters";
    const domain = /^apps\/worker\/src\/registry\/(auth|policy|lifecycle|history)\.[jt]s$/u;
    if (domain.test(from) && domain.test(to) && from !== to) return "Registry domains collaborate through narrow ports, not concrete peer services";
    if (/\/registry\/(?:records|ports|storage|values)\.[jt]s$/u.test(from) && domain.test(to)) return "Registry foundations must not depend on domain implementations";
  }
  if (from.startsWith("apps/worker/src/contracts/") && target === "worker" && !to.startsWith("apps/worker/src/contracts/")) return "application contracts must not depend on implementation or platform adapters";
  if (from === "apps/worker/src/runtime-config.ts" && /\/installer(?:-preflight)?\.[jt]s$/u.test(to)) return "runtime configuration must not depend on distribution templates";
  if (from === "apps/worker/src/public-origin.ts" && target !== "protocol") return "public origin validation must remain a foundation module";
  if (from.startsWith("apps/worker/src/mcp/") && target === "worker" && /\/(?:registry|runner-do|index)\.[jt]s$/u.test(to) && !to.startsWith("apps/worker/src/mcp/")) return "MCP must use application contracts/platform types, not concrete DO/entry modules";
  return undefined;
}
export const RETIRED_PATTERNS = [
  [/\bRUNMESH_SCHEMA_READY\b/u, "runtime schema migration switch"],
  [/\bRUNMESH_PROFILE\b/u, "retired profile environment alias"],
  [/\bRUNMESH_TOKEN\b/u, "retired token environment alias"],
  [/(?:CREATE\s+TABLE|ALTER\s+TABLE|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[`"']?runner_policy_migrations\b/iu, "retired policy-migration table mutation"],
  [/\bmanagement_mode\s*===?\s*["']legacy_local/u, "retired local workspace authority"],
  [/remote-coding-(?:runtime|runner)/iu, "retired product name"],
  [/\bRemoteCodingRunner\b/u, "retired product name"],
];
