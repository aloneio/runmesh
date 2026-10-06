import { isBuiltin } from "node:module";
import { centralDependencyProblem, centralFeature, centralSpecifierProblem } from "./central-architecture-policy.mjs";

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
const runnerRoot = "apps/runner/src/";
const maintenanceSharedSources = new Set([
  "profile.ts", "service.ts", "purge.ts", "windows-tools.ts", "platform-types.ts",
  "version.ts", "generated-version.ts", "config.ts", "environment-contracts.ts", "maintenance-contract.ts", "enrollment.ts",
  "cli/contracts.ts", "cli/input.ts", "cli/lifecycle.ts", "cli/service-plan.ts", "cli/reporting.ts", "cli/enrollment.ts",
]);
export function isMaintenanceSource(path) {
  const source = canonicalSource(path);
  return source === runnerRoot + "maintenance-entry.ts" || source === runnerRoot + "maintenance-cli.ts" || source.startsWith(runnerRoot + "updates/");
}
/** The independently installed manager may share host adapters and stable
 * contracts, but must never load the selected Runner's execution stack. */
export function maintenanceRuntimeInputProblem(path) {
  const source = canonicalSource(path.replaceAll("\\", "/"));
  if (!source.startsWith(runnerRoot)) return undefined;
  if (isMaintenanceSource(source) || source.startsWith(runnerRoot + "services/") || maintenanceSharedSources.has(source.slice(runnerRoot.length))) return undefined;
  return "Maintenance must remain independent of Runner execution and ordinary CLI modules";
}
export function maintenanceGraphProblems(files, edges) {
  const graph = new Map();
  for (const edge of edges.filter(edge => !edge.typeOnly)) {
    const targets = graph.get(edge.from) ?? [];
    targets.push(edge.to); graph.set(edge.from, targets);
  }
  const pending = files.filter(isMaintenanceSource), visited = new Set(), failures = [];
  while (pending.length > 0) {
    const from = pending.pop();
    if (visited.has(from)) continue;
    visited.add(from);
    for (const to of graph.get(from) ?? []) {
      const reason = maintenanceRuntimeInputProblem(to);
      if (reason) failures.push(`${from} -> ${to}: ${reason}`);
      else pending.push(to);
    }
  }
  return failures;
}
const browserRoot = "apps/worker/browser/";
const browserDependencies = {
  "admin-client.ts": ["central/controller.ts", "runner-actions.ts", "locale.ts", "page-controls.ts", "admin-pages.ts", "admin-navigation.ts"],
  "page-controls.ts": ["clipboard.ts", "permission-controls.ts"],
  "permission-controls.ts": [],
  "locale.ts": [], "clipboard.ts": [], "admin-pages.ts": [], "admin-navigation.ts": [],
  "runner-actions.ts": [],
  "central/controller.ts": ["central/api.ts", "central/messages.ts", "central/view.ts", "central/services.ts", "central/skills.ts"],
  "central/api.ts": [], "central/messages.ts": [], "central/view.ts": [],
  "central/services.ts": [], "central/skills.ts": [],
};
const registryRoute = path => /^apps\/worker\/src\/registry\/route-(?:inputs|projections)\.ts$/u.test(canonicalSource(path));
const registryRouteAdapter = path => canonicalSource(path).startsWith("apps/worker/src/registry/routes/");
const runnerUseCase = path => /^apps\/worker\/src\/application\/(?:create-runner|delete-runner|register-runner|runner-(?:credentials|enrollment|lifecycle|policy))\.ts$/u.test(canonicalSource(path));
const requestUseCase = path => /^apps\/worker\/src\/application\/(?:auth-source|enrollment|mcp-identity|runner-queries)\.ts$/u.test(canonicalSource(path));
const registryCoordinator = path => /^apps\/worker\/src\/registry\/(?:history-routes|history-ports|transport-routes)\.ts$/u.test(canonicalSource(path));
const registryPlatformTypes = new Set(["DurableObjectState", "DurableObjectStorage", "DurableObjectNamespace", "DurableObjectStub", "SqlStorage", "D1Database", "D1PreparedStatement", "ExecutionContext", "Fetcher"]);
const networkGlobals = new Set(["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "WebTransport", "Worker", "SharedWorker", "caches", "globalThis", "window", "self", "process", "Deno", "Bun"]);

/** Conservative source guard: stateful workflows receive API and view ports. */
export function boundaryNodeProblem(from, node) {
  const source = canonicalSource(from);
  if (source === "apps/worker/src/registry/release-cache.ts" && (node.type === "AwaitExpression" || node.async === true))
    return "Registry release cache admission must stay synchronous";
  if (source === "apps/worker/src/domain/runner-handshake.ts" && (node.type === "AwaitExpression" || node.async === true))
    return "Runner handshake parsing and projection must stay synchronous";
  if (registryRouteAdapter(source) && (node.type === "AwaitExpression" || node.async === true))
    return "Registry route adapters must preserve synchronous authority checks and mutations";
  if (node.type !== "Identifier") return undefined;
  if (source === "apps/worker/src/registry/release-cache.ts"
    && (registryPlatformTypes.has(node.name) || networkGlobals.has(node.name) || ["WorkerEnv", "Request", "Response", "Date", "crypto", "setTimeout", "setInterval", "queueMicrotask", "eval", "Function"].includes(node.name)))
    return "Registry release cache admission uses supplied values, not platform state or scheduling";
  if (source === "apps/worker/src/job-history-settings.ts" && (registryPlatformTypes.has(node.name) || networkGlobals.has(node.name) || ["Date", "crypto", "setTimeout", "setInterval"].includes(node.name)))
    return "History display defaults use shared protocol values, not storage or ambient I/O";
  if (["apps/worker/src/domain/runner-handshake.ts", "apps/runner/src/environment-contracts.ts"].includes(source)
    && (registryPlatformTypes.has(node.name) || networkGlobals.has(node.name) || ["Date", "crypto", "setTimeout", "setInterval", "queueMicrotask", "eval", "Function"].includes(node.name)))
    return "Handshake rules and environment contracts use supplied values, not platform state or scheduling";
  if (runnerUseCase(source) && (registryPlatformTypes.has(node.name) || networkGlobals.has(node.name) || ["WorkerEnv", "Request", "Response", "Date", "crypto", "setTimeout", "setInterval", "eval", "Function"].includes(node.name)))
    return "Runner use cases receive operation ports and return outcomes, without HTTP or platform state";
  if (requestUseCase(source) && (registryPlatformTypes.has(node.name) || networkGlobals.has(node.name) || ["WorkerEnv", "Request", "Response", "Date", "crypto", "setTimeout", "setInterval", "eval", "Function"].includes(node.name)))
    return "Request use cases receive operation ports and parsed receipts, not HTTP or platform state";
  if (registryCoordinator(source) && (registryPlatformTypes.has(node.name) || networkGlobals.has(node.name) || ["Date", "crypto", "setTimeout", "setInterval"].includes(node.name)))
    return "Registry coordinators receive history and lifecycle ports, not ambient I/O or storage";
  if (registryRouteAdapter(source) && registryPlatformTypes.has(node.name))
    return "Registry route adapters receive operation ports, not platform or storage types";
  if (registryRouteAdapter(source) && (networkGlobals.has(node.name) || ["Date", "Promise", "setTimeout", "setInterval", "queueMicrotask", "eval", "Function"].includes(node.name)))
    return "Registry route adapters use synchronous ports and supplied values, not I/O or scheduling";
  if (registryRoute(source) && (networkGlobals.has(node.name) || ["Date", "eval", "Function"].includes(node.name)))
    return "Registry route parsing and projection must use supplied values, not I/O or ambient state";
  if (source.startsWith(browserRoot + "central/") && source !== browserRoot + "central/api.ts" && networkGlobals.has(node.name))
    return "Central browser workflows and presentation receive network operations through the API port";
  if ([browserRoot + "central/api.ts", browserRoot + "central/messages.ts"].includes(source) && ["document", "location", "history", "window", "globalThis", "self"].includes(node.name))
    return "Central browser API and copy modules must not own DOM or navigation state";
  return undefined;
}
const runnerIoModules = new Set([
  "jobs/ports.ts", "jobs/storage.ts", "jobs/process.ts", "jobs/logs.ts", "jobs/input.ts",
  "context/ports.ts", "context/files.ts", "context/repository.ts", "context/retention.ts", "context/recovery.ts",
  "patch/files.ts", "connection/ports.ts", "connection/metadata.ts", "connection/policy-candidate.ts",
]);
/** New Job/Context/Patch/Connection modules are pure until an adapter role is reviewed. */
function isPureRunner(path) {
  const name = canonicalSource(path).replace(/^apps\/runner\/src\//u, "");
  return name === "path-contracts.ts" || name === "environment-contracts.ts" || name === "maintenance-contract.ts" || /^(?:jobs|context|patch|connection)\//u.test(name) && !runnerIoModules.has(name);
}
const cloudPlatform = /^(?:cloudflare:|cloudflare(?:\/|$)|workerd(?:\/|$)|@cloudflare\/)/u;
const serverSdk = /^(?:@modelcontextprotocol\/|agents(?:\/|$))/u;
const purePackages = /^(?:zod(?:\/|$)|@aloneio\/runmesh-protocol$)/u;
const cloudRoles = new Set(["entry", "platform", "transport_owner", "registry_facade", "persistence", "central_owner"]);
const pureWorkerRoles = new Set(["contracts", "domain", "presentation", "browser", "registry_foundation", "registry_domain", "registry_route"]);
export function specifierProblem(from, specifier, typeOnly) {
  const source = canonicalSource(from);
  const centralProblem = centralSpecifierProblem(source, specifier);
  if (centralProblem) return centralProblem;
  const builtin = specifier.startsWith("node:") || isBuiltin(specifier);
  const external = !specifier.startsWith(".") && !specifier.startsWith("/");
  if (isMaintenanceSource(source) && external && !builtin && !purePackages.test(specifier))
    return "Maintenance dependencies are host primitives and shared protocol contracts";
  if (source === "apps/runner/src/environment-contracts.ts" && external && !purePackages.test(specifier))
    return "Environment contracts must not load platform implementations or types";
  if ((runnerUseCase(source) || requestUseCase(source) || registryCoordinator(source)) && external && !purePackages.test(specifier))
    return "Runner use cases and Registry coordinators must not load platform implementations";
  if (source === "apps/runner/src/jobs/input.ts" && external && !(specifier === "node:stream" && typeOnly))
    return "Job stdin delivery may reference stream types only, not platform implementations";
  if (isPureRunner(source) && external && !purePackages.test(specifier) && !["node:crypto", "crypto", "node:path", "path"].includes(specifier))
    return "Runner record and planning modules must not access platform I/O or unreviewed external packages";
  if (/^apps\/runner\/src\/(?:jobs|context|connection)\/ports\.ts$/u.test(source) && builtin && !typeOnly)
    return "Runner ports may reference platform types but not load platform implementations";
  if (/^apps\/runner\/src\/connection\/ports\.ts$/u.test(source) && external && !typeOnly)
    return "Connection ports must not load external platform implementations";
  if (layer(from) === "worker") {
    const role = workerRole(from);
    if (cloudPlatform.test(specifier) && !cloudRoles.has(role)) return `Worker layer ${role} must not depend on Cloudflare platform packages, including types`;
    if (serverSdk.test(specifier) && !["entry", "http", "mcp"].includes(role)
      && !(role === "platform" && centralFeature(source) === "connectors")) return `Worker layer ${role} must not depend on server SDK packages, including types`;
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
  "capabilities-do.ts": "central_owner",
};
const foundations = new Set(["bounded-json.ts", "public-origin.ts", "mcp-authorization.ts", "job-history-settings.ts", "validity.ts", "body.ts", "security.ts", "runtime-config.ts", "queue-grant.ts", "values.ts", "generated-release.ts", "generated-provenance.ts", "generated-admin-client.ts", "generated-release-validation.ts", "generated-version.ts", "deployment-provenance.ts", "control-plane-errors.ts"]);
export function workerRole(path) {
  if (path.startsWith("apps/worker/browser/")) return "browser";
  if (!path.startsWith("apps/worker/src/")) return layer(path);
  const name = canonicalSource(path.slice("apps/worker/src/".length));
  if (workerRootRoles[name]) return workerRootRoles[name];
  if (foundations.has(name)) return "foundation";
  if (name.startsWith("admin/") || name.startsWith("i18n/")) return "presentation";
  if (name.startsWith("registry/routes/")) return "registry_route";
  if (name.startsWith("registry/")) return /registry\/(records|ports|storage|values|schema|feature-health-model|maintenance-plan)\.[jt]s$/u.test(name) ? "registry_foundation" : "registry_domain";
  for (const role of ["contracts", "domain", "application", "platform", "http", "distribution", "mcp", "presentation"]) if (name.startsWith(role + "/")) return role;
  return "extension";
}
export const WORKER_ALLOWED_DEPENDENCIES = Object.freeze({
  central_owner: ["application", "platform", "contracts", "foundation"],
  browser: ["browser"],
  contracts: ["contracts", "protocol"],
  domain: ["domain", "contracts", "foundation", "protocol"],
  foundation: ["foundation", "contracts", "platform", "protocol"],
  extension: ["extension", "foundation", "contracts", "protocol"],
  presentation: ["presentation", "contracts", "foundation", "distribution", "protocol"],
  distribution: ["distribution", "domain", "contracts", "foundation", "protocol"],
  application: ["application", "domain", "contracts", "foundation", "protocol"],
  platform: ["platform", "contracts", "foundation", "protocol"],
  persistence: ["persistence", "contracts", "foundation", "platform", "protocol"],
  registry_foundation: ["registry_foundation", "foundation", "contracts", "protocol"],
  registry_domain: ["registry_foundation", "registry_domain", "persistence", "foundation", "contracts", "protocol"],
  registry_route: ["registry_route", "registry_domain", "registry_foundation", "foundation", "contracts", "protocol"],
  registry_facade: ["registry_route", "registry_domain", "registry_foundation", "persistence", "foundation", "contracts", "platform", "protocol"],
  transport_owner: ["transport_owner", "domain", "foundation", "contracts", "platform", "protocol"],
  mcp: ["mcp", "contracts", "foundation", "platform", "protocol"],
  http: ["http", "application", "domain", "presentation", "distribution", "foundation", "contracts", "platform", "mcp", "protocol"],
});
export function dependencyProblem(from, to) {
  from = canonicalSource(from); to = canonicalSource(to);
  if (isMaintenanceSource(from)) {
    const reason = maintenanceRuntimeInputProblem(to);
    if (reason) return reason;
  }
  // This pure admission policy shares release validation and cadence rules;
  // the Registry facade and other domains retain their existing boundaries.
  if (from === "apps/worker/src/registry/release-cache.ts") return [
    "apps/worker/src/domain/release-selection.ts", "apps/worker/src/contracts/runner-release.ts",
  ].includes(to) ? undefined : "Registry release cache admission depends only on shared release rules and records";
  if (from === "apps/worker/src/domain/runner-handshake.ts" && to !== "apps/worker/src/values.ts" && !to.startsWith("packages/protocol/src/"))
    return "Runner handshake parsing and projection must not depend on state owners or adapters";
  if (from === "apps/runner/src/environment-contracts.ts" && !to.startsWith("packages/protocol/src/"))
    return "Environment contracts must not depend on concrete probes or coordinators";
  if (from === "apps/runner/src/cli/contracts.ts" && ["apps/runner/src/environment.ts", "apps/runner/src/runtime.ts"].includes(to))
    return "CLI environment dependencies must use structural contracts, not concrete classes";
  if (from === "apps/runner/src/environment.ts" && ["apps/runner/src/runtime.ts", "apps/runner/src/cli.ts"].includes(to))
    return "Environment probes must not depend on runtime or CLI composition";
  if (runnerUseCase(from) && !(runnerUseCase(to) || /^apps\/worker\/src\/(?:contracts|domain)\//u.test(to) || to.startsWith("packages/protocol/src/")))
    return "Runner use cases must depend on contracts and rules, not HTTP or transport adapters";
  if (registryCoordinator(from) && ![
    "apps/worker/src/registry/history-ports.ts", "apps/worker/src/registry/route-inputs.ts",
    "apps/worker/src/registry/route-projections.ts", "apps/worker/src/registry/records.ts",
    "apps/worker/src/registry/values.ts", "apps/worker/src/job-history-settings.ts",
    "apps/worker/src/audit-metadata.ts", "apps/worker/src/control-plane-errors.ts", "apps/worker/src/security.ts",
  ].includes(to) && !to.startsWith("apps/worker/src/contracts/") && !to.startsWith("packages/protocol/src/"))
    return "Registry history and transport coordination must use narrow ports, not concrete owners";
  if (from.startsWith(browserRoot) && !browserDependencies[from.slice(browserRoot.length)]?.includes(to.slice(browserRoot.length)))
    return "Browser imports must follow the reviewed controller, API, presentation and workflow boundaries";
  if (registryRoute(from) && !["apps/worker/src/registry/records.ts", "apps/worker/src/registry/values.ts", "packages/protocol/src/index.ts"].includes(to))
    return "Registry route parsing and projection must not depend on state owners or adapters";
  if (registryRouteAdapter(from) && !(registryRoute(to)
    || to === "apps/worker/src/registry/routes/request.ts"
    || ["apps/worker/src/registry/records.ts", "apps/worker/src/registry/values.ts", "apps/worker/src/security.ts", "apps/worker/src/validity.ts"].includes(to)
    || to.startsWith("apps/worker/src/contracts/") || to.startsWith("packages/protocol/src/")))
    return "Registry route adapters must use narrow ports, not concrete owners, storage or peer adapters";
  const centralProblem = centralDependencyProblem(from, to);
  if (centralProblem) return centralProblem;
  const owner = layer(from), target = layer(to);
  if (from === "apps/runner/src/jobs/input.ts" && target === "runner" && !/^apps\/runner\/src\/(?:jobs\/ports|errors)\.ts$/u.test(to))
    return "Job stdin delivery must not depend on concrete Job state, process or storage implementations";
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
