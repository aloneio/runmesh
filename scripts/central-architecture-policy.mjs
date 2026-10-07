/** Additional feature boundaries; native layer and cycle gates still apply. */
export function centralFeature(path) {
  if (/^apps\/worker\/src\/contracts\/skill-(?:source(?:-values)?|lifecycle(?:-(?:values|receipts))?|manifest|values)\.[cm]?[jt]sx?$/u.test(path)) return "skills";
  if (/^apps\/worker\/src\/contracts\/(?:connector-inspection|mcp-registry)\.[cm]?[jt]sx?$/u.test(path)) return "connectors";
  if (/^apps\/worker\/src\/contracts\/(?:tool-search|remote-server)\.[cm]?[jt]sx?$/u.test(path)) return "capabilities";
  if (path.startsWith('apps/worker/src/contracts/') && /managed-(oauth|connections)[.][cm]?[jt]sx?$/u.test(path)) return 'connectors';
  if (/^apps\/worker\/src\/contracts\/oauth(?:-values)?\.[cm]?[jt]sx?$/u.test(path)) return "connectors";
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
const provider = path => /^apps\/worker\/src\/mcp\/providers\/(?:remote|skills)(?:[/.])/u.test(path);

const storageContracts = new Set(["apps/worker/src/contracts/secret-storage.ts", "apps/worker/src/contracts/base64url.ts", "apps/worker/src/contracts/json.ts"]);
const storageDependencies = new Set([...storageContracts, "apps/worker/src/contracts/deployment-secrets.ts"]);
const sharedProvider = path => path === "apps/worker/src/mcp/providers/schema-publication.ts";

export function centralDependencyProblem(from, to) {
  if (["apps/worker/src/application/connectors/deadline.ts", "apps/worker/src/application/capabilities/remote-deadline.ts", "apps/worker/src/application/skills/source-deadline.ts"].includes(from)
    && to === "apps/worker/src/async-deadline.ts") return undefined;
  if (sharedProvider(from) && !to.startsWith("apps/worker/src/contracts/"))
    return "Shared schema publication must not import feature, request or platform implementations";
  if (provider(from) && sharedProvider(to)) return undefined;
  if (storageContracts.has(from) && !storageContracts.has(to))
    return "Shared encryption contracts must stay independent of feature and platform contracts";
  if (from === "apps/worker/src/platform/secret-storage.ts" && !storageDependencies.has(to))
    return "Shared secret storage depends only on pure contracts, not a feature, transport or repository";
  if (provider(from) && !to.startsWith('apps/worker/src/contracts/')
    && !(provider(to) && centralFeature(from) === centralFeature(to)))
    return 'Central MCP providers receive public ports and provider helpers, not application or platform implementations';
  if (from === 'apps/worker/src/platform/connectors/managed-store.ts' && !to.startsWith('apps/worker/src/contracts/'))
    return 'Managed OAuth persistence must not import protocol or lifecycle implementations';
  if (from === 'apps/worker/src/platform/connectors/managed-oauth.ts' && !to.startsWith('apps/worker/src/contracts/')
    && to !== 'apps/worker/src/platform/connectors/managed-oauth-http.ts')
    return 'Managed OAuth protocol adaptation must not own lifecycle state, persistence or encryption';
  if (from === "apps/worker/src/capabilities-do.ts" && !to.startsWith("apps/worker/src/contracts/")
    && centralFeature(to) === undefined
    && !["apps/worker/src/bounded-json.ts", "apps/worker/src/platform/control-plane.ts", "apps/worker/src/platform/env.ts", "apps/worker/src/platform/secret-storage.ts", "apps/worker/src/security.ts"].includes(to))
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
  // Bounded YAML data parsing is owned by this one pure adapter, never by
  // application services or transport handlers.
  if (from === "apps/worker/src/domain/skills/frontmatter.ts" && specifier === "yaml") return undefined;
  if ((storageContracts.has(from) || from === "apps/worker/src/platform/secret-storage.ts") && !specifier.startsWith("."))
    return "Shared encryption and serialization use local foundation contracts, not external feature SDKs";
  if (unreviewed(from)) return "Central modules require a reviewed feature role";
  if ((centralFeature(from) === undefined && !sharedProvider(from)) || specifier.startsWith(".")) return undefined;
  if ((provider(from) || sharedProvider(from)) && !/^(?:zod(?:\/|$)|@modelcontextprotocol\/server(?:\/|$))/u.test(specifier))
    return 'Central MCP providers use reviewed server/schema SDKs; external implementations belong behind ports';
  if (from === 'apps/worker/src/platform/connectors/managed-store.ts')
    return 'Managed OAuth persistence must use SDK-independent record contracts';
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
  if (from.startsWith("apps/worker/src/") && from !== "apps/worker/src/platform/secret-storage.ts"
    && node.type === "StringLiteral" && node.value === "AES-GCM")
    return "Worker storage encryption belongs to the shared secret-storage adapter";
  if (unreviewed(from)) return node.type === "Program" ? "Central modules require a reviewed feature role" : undefined;
  if ((centralFeature(from) === undefined && !sharedProvider(from)) || node.type !== "Identifier") return undefined;
  if (node.name === "eval" || node.name === "Function") return "Central features must not evaluate imported Skill or tool code";
  if ((/^apps\/worker\/src\/(?:contracts|domain|application)\//u.test(from) || provider(from) || sharedProvider(from)) && ioGlobals.has(node.name))
    return "Central pure contracts, rules and MCP providers must not reference platform I/O globals";
  return undefined;
}
