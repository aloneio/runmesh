import { SKILL_LIMITS, type SkillFile } from "../../contracts/skills.js";
import { skillPath } from "../../contracts/skill-values.js";
import { SKILL_SOURCE_LIMITS, type SkillSource } from "../../contracts/skill-source.js";

type Result = { readonly state: "read"; readonly files: readonly SkillFile[] }
  | { readonly state: "missing" | "invalid" | "capacity" | "fallback" };
const BLOCK = 512;
const MAX_ENTRIES = 4096;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const ascii = (bytes: Uint8Array) => decoder.decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
const number = (bytes: Uint8Array): number | undefined => {
  const text = ascii(bytes).trim();
  return /^[0-7]+$/u.test(text) ? Number.parseInt(text, 8) : undefined;
};

function paxPath(bytes: Uint8Array): string | undefined {
  if (bytes.length > 16384) throw new Error("tar_metadata_limit");
  let cursor = 0, path: string | undefined;
  while (cursor < bytes.length) {
    const space = bytes.indexOf(32, cursor);
    if (space < cursor || space - cursor > 8) throw new Error("tar_metadata_invalid");
    const sizeText = decoder.decode(bytes.subarray(cursor, space));
    if (!/^[1-9][0-9]*$/u.test(sizeText)) throw new Error("tar_metadata_invalid");
    const count = Number(sizeText), end = cursor + count;
    if (!Number.isSafeInteger(count) || end > bytes.length || bytes[end - 1] !== 10) throw new Error("tar_metadata_invalid");
    const entry = decoder.decode(bytes.subarray(space + 1, end - 1));
    const equal = entry.indexOf("=");
    if (equal < 1) throw new Error("tar_metadata_invalid");
    const key = entry.slice(0, equal);
    if (key === "path") path = entry.slice(equal + 1);
    if (key === "size" || key === "linkpath") throw new Error("tar_metadata_unsupported");
    cursor = end;
  }
  return path;
}

/** Pure, bounded GitHub tar parser. Unsupported tar extensions fall back to
 * Git's tree API; unsafe members in the requested subtree are rejected. */
export function readGithubTar(data: Uint8Array, source: SkillSource): Result {
  try {
    const requestedRepo = source.repository.slice(source.repository.lastIndexOf("/") + 1);
    const suffix = "-" + source.commit;
    const files: SkillFile[] = [], seen = new Set<string>();
    let root: string | undefined, selectedBytes = 0, pendingPath: string | undefined, offset = 0, entries = 0;
    let ended = false, sawSelection = false;
    while (offset + BLOCK <= data.length) {
      const header = data.subarray(offset, offset + BLOCK);
      if (header.every(byte => byte === 0)) {
        if (!root || data.subarray(offset).some(byte => byte !== 0)) return { state: "fallback" };
        ended = true;
        break;
      }
      if (++entries > MAX_ENTRIES || ascii(header.subarray(257, 263)).slice(0, 5) !== "ustar") return { state: "fallback" };
      const checksum = number(header.subarray(148, 156));
      let total = 0;
      for (let i = 0; i < BLOCK; i++) total += i >= 148 && i < 156 ? 32 : header[i]!;
      if (checksum === undefined || total !== checksum) return { state: "fallback" };
      const size = number(header.subarray(124, 136));
      if (size === undefined || !Number.isSafeInteger(size) || size < 0) return { state: "fallback" };
      const start = offset + BLOCK, padded = Math.ceil(size / BLOCK) * BLOCK, next = start + padded;
      if (!Number.isSafeInteger(next) || next > data.length) return { state: "fallback" };
      const type = String.fromCharCode(header[156]!);
      const content = data.subarray(start, start + size);
      if (type === "g" || type === "x") {
        const path = paxPath(content);
        if (type === "g" && path !== undefined) return { state: "fallback" };
        if (type === "x") pendingPath = path;
        offset = next;
        continue;
      }
      if (type === "L" || type === "K") return { state: "fallback" };
      const name = ascii(header.subarray(0, 100));
      const prefix = ascii(header.subarray(345, 500));
      const full = pendingPath ?? (prefix ? prefix + "/" + name : name);
      pendingPath = undefined;
      if (!root) {
        if (type !== "5" || !full.endsWith("/") || full.slice(0, -1).includes("/")) return { state: "fallback" };
        const rootName = full.slice(0, -1);
        if (!rootName.toLowerCase().endsWith(suffix)
          || rootName.slice(0, -suffix.length).toLowerCase() !== requestedRepo.toLowerCase()) return { state: "fallback" };
        root = full;
      }
      const target = root + (source.path ? source.path + "/" : "");
      if (full === target && type === "5") sawSelection = true;
      if (full.startsWith(target) && full !== target) {
        sawSelection = true;
        const relative = full.slice(target.length);
        if (type === "5") {
          if (!relative.endsWith("/") || !skillPath(relative.slice(0, -1))) return { state: "invalid" };
        } else if (type === "0" || type === "\0") {
          if (!skillPath(relative) || seen.has(relative.toLowerCase())) return { state: "invalid" };
          seen.add(relative.toLowerCase());
          selectedBytes += size;
          if (files.length >= SKILL_SOURCE_LIMITS.files || size > SKILL_LIMITS.file_bytes || selectedBytes > SKILL_LIMITS.bundle_bytes) return { state: "capacity" };
          let text: string;
          try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content); }
          catch { return { state: "invalid" }; }
          if (text.includes("\0") || text.startsWith("version https://git-lfs.github.com/spec/v1")) return { state: "invalid" };
          files.push({ path: relative, text });
        } else return { state: "invalid" };
      }
      offset = next;
    }
    if (!ended || pendingPath !== undefined) return { state: "fallback" };
    if (!sawSelection || files.length === 0) return { state: "missing" };
    return { state: "read", files };
  } catch {
    return { state: "fallback" };
  }
}
