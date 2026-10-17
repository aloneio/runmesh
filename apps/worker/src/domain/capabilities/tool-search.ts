import { TOOL_SEARCH_LIMITS, type ToolSearchEntry } from "../../contracts/tool-search.js";

interface SearchText { readonly name: string; readonly title?: string; readonly description?: string; readonly profile_name: string }
interface RankedTool { readonly score: number; readonly entry: ToolSearchEntry }
const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
const words = (value: string) => normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Small, deterministic vocabulary; never fetch embeddings or inspect credentials.
 * Alternatives broaden recall without relaxing the every-term requirement. */
const ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  repo: ["repository", "仓库"], repository: ["repo", "仓库"], 仓库: ["repository", "repo"],
  issues: ["issue", "问题"], issue: ["issues", "问题"], 问题: ["issue", "issues"],
  deploy: ["deployment", "部署"], deployment: ["deploy", "部署"], 部署: ["deploy", "deployment"],
  merge: ["合并"], 合并: ["merge"],
  files: ["file", "文件"], file: ["files", "文件"], 文件: ["file", "files"],
  search: ["find", "搜索"], find: ["search", "搜索"], 搜索: ["search", "find"],
});

/** Exact names rank first; every keyword must occur in the tool or its connection.
 * Unicode substring matching handles Chinese keywords without a locale dependency. */
export function createToolSearchScorer(query: string): (tool: SearchText) => number {
  const terms = [...new Set(words(query))], exact = normalize(query.trim());
  return tool => {
    if (!terms.length) return 0;
    const name = normalize(tool.name), title = normalize(tool.title ?? ""), description = normalize(tool.description ?? ""),
      profile = normalize(tool.profile_name), nameWords = new Set(words(tool.name));
    let score = name === exact ? 1000 : 0;
    for (const term of terms) {
      const relevance = (candidate: string) => nameWords.has(candidate) ? 100 : name.includes(candidate) ? 60
        : title.includes(candidate) ? 30 : description.includes(candidate) ? 10 : profile.includes(candidate) ? 5 : 0;
      const direct = relevance(term);
      const match = direct || Math.max(0, ...(ALIASES[term] ?? []).map(alias => Math.floor(relevance(alias) / 2)));
      if (!match) return 0;
      score += match;
    }
    return score;
  };
}

const compare = (left: RankedTool, right: RankedTool) => right.score - left.score
  || (left.entry.profile_id < right.entry.profile_id ? -1 : left.entry.profile_id > right.entry.profile_id ? 1 : 0)
  || (left.entry.tool_id < right.entry.tool_id ? -1 : left.entry.tool_id > right.entry.tool_id ? 1 : 0);

/** Retain at most k metadata records, irrespective of the catalog size or input order. */
export function createToolSearchRanking(limit: number) {
  const ranked: RankedTool[] = [], boundedLimit = Math.max(1, Math.min(TOOL_SEARCH_LIMITS.results, Math.trunc(limit) || TOOL_SEARCH_LIMITS.default_results));
  return {
    offer(score: number, entry: ToolSearchEntry): void {
      if (!Number.isFinite(score) || score <= 0) return;
      ranked.push({ score, entry }); ranked.sort(compare);
      if (ranked.length > boundedLimit) ranked.pop();
    },
    results(): readonly ToolSearchEntry[] { return ranked.map(item => item.entry); },
  };
}

export function toolSearchDescription(description: string | undefined): string {
  const text = (description ?? "").replace(/\s+/gu, " ").trim();
  if (text.length <= TOOL_SEARCH_LIMITS.description_chars) return text;
  // Avoid splitting a UTF-16 surrogate pair at the summary boundary.
  const end = TOOL_SEARCH_LIMITS.description_chars - 1;
  return text.slice(0, /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "") ? end - 1 : end) + "…";
}
