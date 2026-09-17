import { isBuiltin } from "node:module";

/** Source-only dependency policy; tooling/test dependencies are not runtime layers. */
export const SOURCE_ROOTS = ["apps/worker/src", "apps/runner/src", "packages/protocol/src", "apps/worker/browser"];
export const SOURCE_PACKAGES = {
  "@aloneio/runmesh-protocol": "packages/protocol/src/index.ts",
  "@aloneio/runmesh-runner": "apps/runner/src/index.ts",
  "@aloneio/runmesh-worker": "apps/worker/src/index.ts",
};
export const MISSING_GENERATED = new Set(["apps/worker/src/generated-provenance.ts", "apps/worker/src/generated-admin-client.ts", "apps/worker/src/generated-release-validation.ts"]);
export function layer(path) {
  return path.startsWith("packages/protocol/src/") ? "protocol"
    : (path.startsWith("apps/worker/src/") || path.startsWith("apps/worker/browser/")) ? "worker"
    : path.startsWith("apps/runner/src/") ? "runner" : "outside";
}
/** All parser-supported extensions receive the same architecture role. */
const canonicalSource = path => path.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/u, ".ts");
const runnerIoModules = new Set([
  "jobs/ports.ts", "jobs/storage.ts", "jobs/process.ts", "jobs/logs.ts",
  "context/ports.ts", "context/files.ts", "context/repository.ts", "context/retention.ts", "context/recovery.ts",
  "patch/files.ts", "connection/ports.ts", "connection/metadata.ts", "connection/policy-candidate.ts",
]);
/** New Job/Context/Patch/Connection modules are pure until an adapter role is reviewed. */
function isPureRunner(path) {
  const name = canonicalSource(path).replace(/^apps\/runner\/src\//u, "");
  return name === "path-contracts.ts" || /^(?:jobs|context|patch|connection)\//u.test(name) && !runnerIoModules.has(name);
}
const cloudPlatform = /^(?:cloudflare:|cloudflare(?:\/|$)|workerd(?:\/|$)|@cloudflare\/)/u;
const serverSdk = /^(?:@modelcontextprotocol\/|agents(?:\/|$))/u;
const purePackages = /^(?:zod(?:\/|$)|@aloneio\/runmesh-protocol$)/u;
const cloudRoles = new Set(["entry", "platform", "transport_owner", "registry_facade", "persistence"]);
const pureWorkerRoles = new Set(["contracts", "domain", "presentation", "browser", "registry_foundation", "registry_domain"]);
export function specifierProblem(from, specifier, typeOnly) {
  const source = canonicalSource(from);
  const builtin = specifier.startsWith("node:") || isBuiltin(specifier);
  const external = !specifier.startsWith(".") && !specifier.startsWith("/");
  if (isPureRunner(source) && external && !purePackages.test(specifier) && !["node:crypto", "crypto", "node:path", "path"].includes(specifier))
    return "Runner record and planning modules must not access platform I/O or unreviewed external packages";
  if (/^apps\/runner\/src\/(?:jobs|context|connection)\/ports\.ts$/u.test(source) && builtin && !typeOnly)
    return "Runner ports may reference platform types but not load platform implementations";
  if (/^apps\/runner\/src\/connection\/ports\.ts$/u.test(source) && external && !typeOnly)
    return "Connection ports must not load external platform implementations";
  if (layer(from) === "worker") {
    const role = workerRole(from);
    if (cloudPlatform.test(specifier) && !cloudRoles.has(role)) return `Worker layer ${role} must not depend on Cloudflare platform packages, including types`;
    if (serverSdk.test(specifier) && !["entry", "http", "mcp"].includes(role)) return `Worker layer ${role} must not depend on server SDK packages, including types`;
    if (pureWorkerRoles.has(role) && external && !purePackages.test(specifier)) return `Worker layer ${role} must not depend on unreviewed external packages`;
  }
  return undefined;
}
/** Explicit worker roles. Unknown modules are extensions, not trusted foundations. */
const workerRootRoles = {
  "index.ts": "entry", "production.ts": "entry", "registry.ts": "registry_facade", "runner-do.ts": "transport_owner",
  "admin-styles.ts": "presentation", "history-ui.ts": "presentation", "ui-locale.ts": "presentation", "ui-catalog.ts": "presentation",
  "admin-jobs.ts": "http", "installer.ts": "distribution", "installer-preflight.ts": "distribution",
  "job-history-store.ts": "persistence", "external-audit.ts": "persistence", "history-retention.ts": "persistence", "audit-metadata.ts": "persistence", "auth-throttle.ts": "persistence",
  "auth-settings.ts": "application",
};
const foundations = new Set(["public-origin.ts", "mcp-authorization.ts", "job-history-settings.ts", "validity.ts", "body.ts", "security.ts", "runtime-config.ts", "queue-grant.ts", "values.ts", "generated-release.ts", "generated-provenance.ts", "generated-admin-client.ts", "generated-release-validation.ts", "generated-version.ts", "deployment-provenance.ts", "control-plane-errors.ts"]);
export function workerRole(path) {
  if (path.startsWith("apps/worker/browser/")) return "browser";
  if (!path.startsWith("apps/worker/src/")) return layer(path);
  const name = canonicalSource(path.slice("apps/worker/src/".length));
  if (workerRootRoles[name]) return workerRootRoles[name];
  if (foundations.has(name)) return "foundation";
  if (name.startsWith("admin/") || name.startsWith("i18n/")) return "presentation";
  if (name.startsWith("registry/")) return /registry\/(records|ports|storage|values|schema|feature-health-model|maintenance-plan)\.[jt]s$/u.test(name) ? "registry_foundation" : "registry_domain";
  for (const role of ["contracts", "domain", "application", "platform", "http", "distribution", "mcp", "presentation"]) if (name.startsWith(role + "/")) return role;
  return "extension";
}
export const WORKER_ALLOWED_DEPENDENCIES = Object.freeze({
  browser: ["browser"],
  contracts: ["contracts", "protocol"],
  domain: ["domain", "contracts", "foundation", "protocol"],
  foundation: ["foundation", "contracts", "platform", "protocol"],
  extension: ["extension", "foundation", "contracts", "protocol"],
  presentation: ["presentation", "contracts", "foundation", "distribution", "protocol"],
  distribution: ["distribution", "domain", "contracts", "foundation", "protocol"],
  application: ["application", "domain", "contracts", "foundation", "platform", "protocol"],
  platform: ["platform", "contracts", "foundation", "protocol"],
  persistence: ["persistence", "contracts", "foundation", "platform", "protocol"],
  registry_foundation: ["registry_foundation", "foundation", "contracts", "protocol"],
  registry_domain: ["registry_foundation", "registry_domain", "persistence", "foundation", "contracts", "protocol"],
  registry_facade: ["registry_domain", "registry_foundation", "persistence", "foundation", "contracts", "platform", "protocol"],
  transport_owner: ["transport_owner", "foundation", "contracts", "platform", "protocol"],
  mcp: ["mcp", "contracts", "foundation", "platform", "protocol"],
  http: ["http", "application", "domain", "presentation", "distribution", "foundation", "contracts", "platform", "mcp", "protocol"],
});
export function dependencyProblem(from, to) {
  from = canonicalSource(from); to = canonicalSource(to);
  const owner = layer(from), target = layer(to);
  if (from.startsWith("apps/runner/src/connection/") && /^apps\/runner\/src\/(?:connection|runtime|policy-store|jobs|cli|index)\.ts$/u.test(to)) return "Connection modules must use narrow ports, not coordinator or concrete runtime classes";

  if (/^apps\/runner\/src\/(patch|git)\//u.test(from) && /^apps\/runner\/src\/(patch-service|git-service|cli|runtime)\.[jt]s$/u.test(to)) return "File/Git internals cannot depend on their coordinator or entrypoints";
  if (/^apps\/runner\/src\/patch\/(parse|transform|preview)\.[jt]s$/u.test(from) && /\/patch\/files\.[jt]s$/u.test(to)) return "Patch planning must not depend on file mutation adapters";

  if (from.startsWith("apps/runner/src/services/") && /^apps\/runner\/src\/(?:service|cli|runtime)\.[jt]s$/u.test(to)) return "Service adapters must not depend on their facade or CLI/runtime entrypoints";
  if (from.startsWith("apps/runner/src/cli/") && /^apps\/runner\/src\/cli\.[jt]s$/u.test(to)) return "CLI commands must not import the dispatcher facade";

  if (owner === "worker" && target === "worker") {
    const sourceRole = workerRole(from), targetRole = workerRole(to);
    const allowed = WORKER_ALLOWED_DEPENDENCIES[sourceRole];
    if (allowed && !allowed.includes(targetRole)) return `Worker layer ${sourceRole} must not depend on ${targetRole}`;
    if (from.startsWith("apps/worker/src/mcp/results/") && /^apps\/worker\/src\/mcp\/(handlers\/|transport\.|dispatch\.|server\.|audit\.|selection\.|authorization\.)/u.test(to)) return "MCP result projection must not depend on dispatch, transport or handlers";
  }
  if (target === "outside") return "source dependency leaves the application/protocol boundary";
  if (owner === "protocol" && target !== "protocol") return "protocol must not depend on an application";
  if (owner !== "protocol" && target !== "protocol" && target !== owner) return "Worker and Runner must not depend on one another";
  if (isPureRunner(from) && target === "runner" && !isPureRunner(to)
    && !/^apps\/runner\/src\/(?:errors|config|protocol-types)\.ts$/u.test(to)) return "Runner record and planning modules must not depend on concrete I/O adapters";
  if (/^apps\/runner\/src\/(?:jobs|context)\//u.test(from)) {
    if (/^apps\/runner\/src\/(?:jobs|context-store|runtime|connection|cli|index|service|profile)\.[jt]s$/u.test(to)) return "Runner internals must not import their facade, transport or service entrypoints";
    if (isPureRunner(from) && target === "runner" && !isPureRunner(to) && !/^apps\/runner\/src\/(?:errors|config)\.[jt]s$/u.test(to)) return "Runner record and planning modules must not depend on concrete I/O adapters";
    if (/\/(?:jobs|context)\/ports\.[jt]s$/u.test(from) && target === "runner" && !isPureRunner(to)) return "Runner ports must not depend on concrete adapters";
    if (/\/jobs\/logs\.[jt]s$/u.test(from) && /\/jobs\/(?:process|storage)\.[jt]s$/u.test(to)) return "Job log reading uses narrow ports, not process or record-storage implementations";
  }
  if (from.startsWith("apps/worker/src/registry/")) {
    if (/^apps\/worker\/src\/(?:registry|runner-do|index|external-audit|job-history-store)\.[jt]s$/u.test(to)
      || /^apps\/worker\/src\/(?:mcp|ui|admin|http)\//u.test(to)) return "Registry domains must not depend on concrete DO, HTTP/UI or remote history adapters";
    const domain = /^apps\/worker\/src\/registry\/(auth|policy|lifecycle|history)\.[jt]s$/u;
    if (domain.test(from) && domain.test(to) && from !== to) return "Registry domains collaborate through narrow ports, not concrete peer services";
    if (/\/registry\/(?:records|ports|storage|values)\.[jt]s$/u.test(from) && domain.test(to)) return "Registry foundations must not depend on domain implementations";
  }
  if (from.startsWith("apps/worker/src/contracts/") && target === "worker" && !to.startsWith("apps/worker/src/contracts/")) return "application contracts must not depend on implementation or platform adapters";
  if (from.startsWith("apps/worker/src/distribution/") && /^apps\/worker\/src\/installer(?:-preflight)?\.ts$/u.test(to)) return "Release discovery must not depend on installer rendering";
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
