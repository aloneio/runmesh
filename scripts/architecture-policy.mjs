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
export function dependencyProblem(from, to) {
  const owner = layer(from), target = layer(to);
  if (target === "outside") return "source dependency leaves the application/protocol boundary";
  if (owner === "protocol" && target !== "protocol") return "protocol must not depend on an application";
  if (owner !== "protocol" && target !== "protocol" && target !== owner) return "Worker and Runner must not depend on one another";
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
