import { parse } from "@babel/parser";
import { centralNodeProblem } from "./central-architecture-policy.mjs";
import { builtinModules } from "node:module";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { SOURCE_ROOTS, SOURCE_PACKAGES, MISSING_GENERATED, RETIRED_PATTERNS, layer, dependencyProblem, specifierProblem } from "./architecture-policy.mjs";

const builtin = new Set(builtinModules.map(name => name.replace(/^node:/u, "")));
const extensions = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const platform = /^(?:cloudflare:|cloudflare\/|cloudflare$|workerd(?:\/|$)|@cloudflare\/|@modelcontextprotocol\/|agents(?:\/|$))/u;
const sourceVariants = path => [...new Set([
  path.replace(/\.js$/u, ".ts").replace(/\.mjs$/u, ".mts").replace(/\.cjs$/u, ".cts"), path,
  ...[".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"].map(ext => path + ext),
  ...[".ts", ".js"].map(ext => path + "/index" + ext),
])];

/** Syntax inspection only: never import or evaluate scanned source. */
export function dependencies(text, filename, inspectNode = () => undefined) {
  const ast = parse(text, { sourceType: "unambiguous", plugins: ["typescript", ...(filename.endsWith("x") ? ["jsx"] : [])], createImportExpressions: true, attachComment: false });
  const found = [];
  const add = (node, source, typeOnly = false) => {
    const value = source?.type === "StringLiteral" ? source.value
      : source?.type === "TemplateLiteral" && source.expressions.length === 0 ? source.quasis[0]?.value.cooked : undefined;
    found.push({ specifier: value, typeOnly, line: node.loc?.start.line ?? 1 });
  };
  const walk = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    inspectNode(node);
    switch (node.type) {
      case "ImportDeclaration":
        add(node, node.source, node.importKind === "type" || node.specifiers.length > 0 && node.specifiers.every(item => item.importKind === "type")); break;
      case "ExportAllDeclaration": case "ExportNamedDeclaration":
        if (node.source) add(node, node.source, node.exportKind === "type" || node.specifiers?.length > 0 && node.specifiers.every(item => item.exportKind === "type")); break;
      case "ImportExpression": add(node, node.source); break;
      case "TSImportType": add(node, node.source ?? node.argument, true); break;
      case "TSExternalModuleReference": add(node, node.expression); break;
      case "CallExpression":
        if (node.callee?.type === "Import" || node.callee?.type === "Identifier" && node.callee.name === "require") add(node, node.arguments[0]);
        break;
    }
    for (const [key, value] of Object.entries(node))
      if (!["loc", "start", "end", "extra", "comments", "tokens"].includes(key)) walk(value);
  };
  walk(ast.program); return found;
}

/** Strongly connected components; runtime and type-inclusive components both fail the gate. */
export function cycles(files, edges) {
  const graph = new Map(files.map(file => [file, []]));
  for (const edge of edges) graph.get(edge.from)?.push(edge.to);
  let next = 0;
  const indices = new Map(), low = new Map(), stack = [], active = new Set(), result = [];
  const visit = file => {
    indices.set(file, next); low.set(file, next++); stack.push(file); active.add(file);
    for (const target of graph.get(file) ?? []) {
      if (!graph.has(target)) continue;
      if (!indices.has(target)) { visit(target); low.set(file, Math.min(low.get(file), low.get(target))); }
      else if (active.has(target)) low.set(file, Math.min(low.get(file), indices.get(target)));
    }
    if (low.get(file) !== indices.get(file)) return;
    const group = []; let value;
    do { value = stack.pop(); active.delete(value); group.push(value); } while (value !== file);
    if (group.length > 1 || graph.get(file).includes(file)) result.push(group.sort());
  };
  for (const file of files) if (!indices.has(file)) visit(file);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

export async function checkArchitecture(root) {
  const failures = [], sources = new Map(), edges = [];
  let bytes = 0, entries = 0;
  const collect = async folder => {
    const info = await lstat(join(root, folder));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("source root is not a regular directory");
    for (const item of await readdir(join(root, folder), { withFileTypes: true })) {
      if (++entries > 20000) throw new Error("source entry budget exhausted");
      const path = folder + "/" + item.name;
      if (item.isSymbolicLink()) { failures.push(`${path}: source symlink is not supported`); continue; }
      if (item.isDirectory()) { await collect(path); continue; }
      if (!item.isFile() || !extensions.test(path)) continue;
      const stat = await lstat(join(root, path));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576 || (bytes += stat.size) > 16777216 || sources.size >= 5000) throw new Error("source byte/file budget exhausted or file changed");
      sources.set(path, await readFile(join(root, path), "utf8"));
    }
  };
  for (const rootPath of SOURCE_ROOTS) await collect(rootPath);
  const resolve = (file, specifier) => {
    if (specifier.startsWith(".")) {
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      const reason = dependencyProblem(file, target);
      if (reason) return { reason };
      const path = sourceVariants(target).find(value => sources.has(value));
      return path ? { path } : MISSING_GENERATED.has(target.replace(/\.js$/u, ".ts")) ? {} : { reason: "unresolved relative source import" };
    }
    for (const [name, target] of Object.entries(SOURCE_PACKAGES)) {
      if (specifier === name || specifier.startsWith(name + "/")) {
        const reason = dependencyProblem(file, target);
        if (reason) return { reason };
        if (specifier !== name) return { reason: "source package subpaths require a reviewed resolver mapping" };
        return sources.has(target) ? { path: target } : { reason: "unresolved source package entry" };
      }
    }
    const owner = layer(file);
    if ((specifier.startsWith("node:") || builtin.has(specifier)) && owner !== "runner") return { reason: "Node platform dependency outside Runner" };
    if (platform.test(specifier) && owner !== "worker") return { reason: "Worker/platform dependency outside Worker" };
    if (/^(?:#|[A-Za-z]:|\/|\\)|\\|\?/u.test(specifier)) return { reason: "unmapped alias or non-package import requires explicit review" };
    return {};
  };
  for (const [file, text] of sources) {
    for (const [pattern, reason] of RETIRED_PATTERNS) if (pattern.test(text)) failures.push(`${file}: contains ${reason}`);
    let imports;
    try { imports = dependencies(text, file, node => {
      const reason = centralNodeProblem(file, node);
      if (reason) failures.push(`${file}:${node.loc?.start.line ?? 1}: ${reason}`);
    }); }
    catch { failures.push(`${file}: source parsing failed`); continue; }
    for (const edge of imports) {
      if (typeof edge.specifier !== "string") { failures.push(`${file}:${edge.line}: computed module loading is not statically reviewable`); continue; }
      const platformReason = specifierProblem(file, edge.specifier, edge.typeOnly);
      if (platformReason) failures.push(`${file}:${edge.line}: ${platformReason}`);
      const target = resolve(file, edge.specifier);
      if (target.reason) failures.push(`${file}:${edge.line}: ${target.reason}`);
      if (target.path) {
        const resolvedReason = dependencyProblem(file, target.path);
        if (resolvedReason && resolvedReason !== target.reason) failures.push(`${file}:${edge.line}: ${resolvedReason}`);
        edges.push({ from: file, to: target.path, typeOnly: edge.typeOnly });
      }
    }
  }
  const files = [...sources.keys()].sort();
  const runtimeCycles = cycles(files, edges.filter(edge => !edge.typeOnly));
  for (const cycle of runtimeCycles) failures.push(`runtime dependency cycle: ${cycle.join(" -> ")}`);
  const allCycles = cycles(files, edges);
  for (const cycle of allCycles) if (!runtimeCycles.some(other => JSON.stringify(other) === JSON.stringify(cycle))) failures.push(`type-inclusive dependency cycle: ${cycle.join(" -> ")}`);
  return { failures, files, edges, runtimeCycles, typeCycles: allCycles.filter(group => !runtimeCycles.some(other => JSON.stringify(other) === JSON.stringify(group))), sourceBytes: bytes };
}
