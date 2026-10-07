import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";

export const SKILL_FRONTMATTER_LIMITS = Object.freeze({ bytes: 8192, nodes: 512, depth: 8 });
export type SkillMetadata = { readonly [key: string]: string | number | boolean | null | SkillMetadata | readonly unknown[] };

/** Parse data only. Bounds apply to the syntax tree before any JS conversion. */
export function skillFrontmatter(text: string): SkillMetadata | undefined {
  const normalized = text.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const match = /\n---(?:\n|$)/u.exec(normalized.slice(4));
  if (!match) return undefined;
  const source = normalized.slice(4, 4 + match.index);
  if (new TextEncoder().encode(source).byteLength > SKILL_FRONTMATTER_LIMITS.bytes) return undefined;
  try {
    const doc = parseDocument(source, { schema: "core", uniqueKeys: true, customTags: [], merge: false, strict: true });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) return undefined;
    let nodes = 0;
    function valid(node: Node | null | undefined, depth: number): boolean {
      if (++nodes > SKILL_FRONTMATTER_LIMITS.nodes || depth > SKILL_FRONTMATTER_LIMITS.depth || !node || isAlias(node) || node.tag) return false;
      if (isScalar(node)) return ["string", "boolean", "number"].includes(typeof node.value)
        ? typeof node.value !== "number" || Number.isFinite(node.value) : node.value === null;
      if (isSeq(node)) return node.items.every(item => valid(item as Node, depth + 1));
      if (isMap(node)) return node.items.every(pair => isScalar(pair.key) && typeof pair.key.value === "string"
        && !["__proto__", "prototype", "constructor", "<<"].includes(pair.key.value)
        && valid(pair.key, depth + 1) && valid(pair.value as Node, depth + 1));
      return false;
    }
    if (!valid(doc.contents, 0)) return undefined;
    return doc.toJS({ maxAliasCount: 0 }) as SkillMetadata;
  } catch { return undefined; }
}
