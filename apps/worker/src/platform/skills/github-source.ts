import { SKILL_SOURCE_LIMITS, type SkillSourcePort } from "../../contracts/skill-source.js";
import { SKILL_LIMITS, type SkillFile } from "../../contracts/skills.js";
import { parseSkillSource } from "../../contracts/skill-source-values.js";
import { skillObject, skillPath } from "../../contracts/skill-values.js";

class SourceFault extends Error {
  public constructor(readonly state: "missing" | "invalid" | "capacity" | "unavailable") { super(state); }
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);

/** Source-specific fixed hosts. Never uses MCP egress policy or credentials. */
export function createGithubSkillSource(send: typeof fetch = fetch): SkillSourcePort {
  return {
    async read(raw, signal) {
      const source = parseSkillSource(raw);
      if (!source) return { state: "invalid" };
      const repo = source.repository.slice("https://github.com/".length);
      let requests = 0, totalBytes = 0;
      async function bytes(url: string, limit: number): Promise<Uint8Array> {
        if (signal.aborted) throw new SourceFault("unavailable");
        if (++requests > SKILL_SOURCE_LIMITS.files + SKILL_SOURCE_LIMITS.directory_depth + 3) throw new SourceFault("capacity");
        const response = await send(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal,
          headers: { accept: "application/vnd.github+json", "user-agent": "Runmesh-Skill-Import", "x-github-api-version": "2022-11-28" } });
        const cancel = () => { void response.body?.cancel().catch(() => undefined); };
        if (response.status === 404) { cancel(); throw new SourceFault("missing"); }
        if (!response.ok || response.status !== 200) { cancel(); throw new SourceFault("unavailable"); }
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) { cancel(); throw new SourceFault("capacity"); }
        if (!response.body) throw new SourceFault("invalid");
        const reader = response.body.getReader();
        let value = new Uint8Array(0), size = 0, empty = 0;
        const abort = () => { void reader.cancel().catch(() => undefined); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          while (!signal.aborted) {
            const next = await reader.read();
            if (signal.aborted) break;
            if (next.done) return value.slice(0, size);
            if (next.value.byteLength > limit - size) throw new SourceFault("capacity");
            if (!next.value.byteLength && ++empty > 128) throw new SourceFault("invalid");
            if (size + next.value.byteLength > value.byteLength) {
              const grown = new Uint8Array(Math.min(limit, Math.max(16_384, size + next.value.byteLength, value.byteLength * 2)));
              grown.set(value.subarray(0, size)); value = grown;
            }
            value.set(next.value, size); size += next.value.byteLength;
          }
          throw new SourceFault("unavailable");
        } finally { signal.removeEventListener("abort", abort); abort(); try { reader.releaseLock(); } catch { /* A canceled read settles asynchronously. */ } }
      }
      async function json(path: string) {
        const value = await bytes("https://api.github.com/repos/" + repo + path, SKILL_SOURCE_LIMITS.metadata_bytes);
        return skillObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)));
      }
      async function tree(id: string, recursive = false) {
        const value = await json("/git/trees/" + id + (recursive ? "?recursive=1" : ""));
        if (!value || value.sha !== id || value.truncated !== false || !Array.isArray(value.tree)
          || value.tree.length > SKILL_SOURCE_LIMITS.tree_entries) throw new SourceFault("capacity");
        return value.tree.map(item => { const entry = skillObject(item); if (!entry || typeof entry.path !== "string" || (recursive && !skillPath(entry.path)) || !sha(entry.sha)) throw new SourceFault("invalid"); return entry; });
      }
      try {
        const commit = await json("/git/commits/" + source.commit), root = skillObject(commit?.tree);
        if (commit?.sha !== source.commit || !sha(root?.sha)) throw new SourceFault("invalid");
        let treeId = root.sha;
        for (const part of source.path ? source.path.split("/") : []) {
          const entry = (await tree(treeId)).find(value => value.path === part);
          if (!entry) throw new SourceFault("missing");
          if (entry.type !== "tree" || entry.mode !== "040000") throw new SourceFault("invalid");
          treeId = entry.sha as string;
        }
        const entries = await tree(treeId, true), files: SkillFile[] = [], seen = new Set<string>();
        const blobs = entries.filter(entry => entry.type !== "tree");
        if (!blobs.length || blobs.length > SKILL_SOURCE_LIMITS.files) throw new SourceFault("capacity");
        for (const entry of entries) {
          const path = entry.path as string;
          if (seen.has(path.toLowerCase())) throw new SourceFault("invalid");
          seen.add(path.toLowerCase());
          if (entry.type === "tree" && entry.mode === "040000") continue;
          if (entry.type !== "blob" || !["100644", "100755"].includes(String(entry.mode))
            || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0) throw new SourceFault("invalid");
          totalBytes += entry.size as number;
          if ((entry.size as number) > SKILL_LIMITS.file_bytes || totalBytes > SKILL_LIMITS.bundle_bytes) throw new SourceFault("capacity");
        }
        for (const entry of blobs) {
          const path = entry.path as string;
          const content = await bytes("https://raw.githubusercontent.com/" + repo + "/" + source.commit + "/"
            + (source.path ? source.path + "/" : "") + path, SKILL_LIMITS.file_bytes);
          if (content.byteLength !== entry.size) throw new SourceFault("invalid");
          let text: string;
          try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); }
          catch { throw new SourceFault("invalid"); }
          if (text.includes("\0") || text.startsWith("version https://git-lfs.github.com/spec/v1")) throw new SourceFault("invalid");
          files.push({ path, text });
        }
        return { state: "read", files };
      } catch (error) { return { state: error instanceof SourceFault ? error.state : "unavailable" }; }
    }
  };
}
