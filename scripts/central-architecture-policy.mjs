/** Additional feature boundaries; native layer and cycle gates still apply. */
export function centralFeature(path) {
  if (/^apps\/worker\/src\/contracts\/remote(?:-values)?\.[cm]?[jt]sx?$/u.test(path)) return "capabilities";
  if (/^apps\/worker\/src\/contracts\/catalog(?:-(?:json|schema|values))?\.[cm]?[jt]sx?$/u.test(path)) return "capabilities";
  if (/^apps\/worker\/src\/contracts\/connector-values\.[cm]?[jt]sx?$/u.test(path)) return "connectors";
  const contract = /^apps\/worker\/src\/contracts\/(identity|capabilities|connectors|skills)\.[cm]?[jt]sx?$/u.exec(path);
  if (contract) return contract[1];
  const nested = /^apps\/worker\/src\/(?:domain|application|platform)\/(capabilities|connectors|skills)\//u.exec(path);
  if (nested) return nested[1];
  const provider = /^apps\/worker\/src\/mcp\/providers\/(remote|skills)(?:[/.])/u.exec(path);
  return provider?.[1] === "remote" ? "connectors" : provider?.[1];
}

const unreviewed = path => /^apps\/worker\/src\/(?:capabilities|connectors|skills)\//u.test(path);

export function centralDependencyProblem(from, to) {
  if (from === "apps/worker/src/capabilities-do.ts" && !to.startsWith("apps/worker/src/contracts/")
    && centralFeature(to) === undefined
    && !["apps/worker/src/platform/bounded-json.ts", "apps/worker/src/platform/control-plane.ts", "apps/worker/src/platform/env.ts"].includes(to))
    return "Central state composition may use central features and reviewed identity ports, not native use cases";
  if (unreviewed(from) || unreviewed(to)) return "Central modules require a reviewed domain, application, platform or provider role";
  const feature = centralFeature(from);
  if (feature === undefined) {
    if (centralFeature(to) !== undefined && !to.startsWith("apps/worker/src/contracts/")
      && !/^apps\/worker\/src\/(?:http\/|index\.[jt]s$|production\.[jt]s$|capabilities-do\.[jt]s$)/u.test(from))
      return "Only composition may introduce central feature implementations into native code";
    return undefined;
  }
  if (to.startsWith("apps/worker/src/contracts/")) return undefined;
  if (centralFeature(to) !== feature) return "Central features must collaborate through public contracts, not peer internals or native Runner implementation";
  if (from.startsWith("apps/worker/src/domain/") && !to.startsWith("apps/worker/src/domain/"))
    return "Central domain rules must not access execution, network or storage adapters";
  if (from.startsWith("apps/worker/src/application/") && to.startsWith("apps/worker/src/platform/"))
    return "Central use cases receive narrow ports; only composition may instantiate platform adapters";
  return undefined;
}

export function centralSpecifierProblem(from, specifier) {
  if (unreviewed(from)) return "Central modules require a reviewed feature role";
  if (centralFeature(from) === undefined || specifier.startsWith(".")) return undefined;
  if (/^(?:node:)?(?:child_process|cluster|worker_threads)(?:\/|$)/u.test(specifier))
    return "Central features must not start host processes or become a Skill executor";
  if (/^apps\/worker\/src\/(?:contracts|domain|application)\//u.test(from) && !/^zod(?:\/|$)/u.test(specifier))
    return "Central rules and use cases must not load SDKs or external platform types";
  return undefined;
}

const ioGlobals = new Set(["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "WebTransport", "Worker", "SharedWorker", "caches", "globalThis", "window", "self", "process", "Deno", "Bun"]);

/** A conservative source gate, not a sandbox or proof against arbitrary obfuscation.
 * Pure contracts/rules use narrow ports rather than platform-global aliases. */
export function centralNodeProblem(from, node) {
  if (unreviewed(from)) return node.type === "Program" ? "Central modules require a reviewed feature role" : undefined;
  if (centralFeature(from) === undefined || node.type !== "Identifier") return undefined;
  if (node.name === "eval" || node.name === "Function") return "Central features must not evaluate imported Skill or tool code";
  if (/^apps\/worker\/src\/(?:contracts|domain|application)\//u.test(from) && ioGlobals.has(node.name))
    return "Central pure contracts and rules must not reference platform I/O globals";
  return undefined;
}
