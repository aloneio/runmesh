import { gunzipSync } from "node:zlib";
import { posix } from "node:path";

export interface ReleaseArchiveFile { readonly path: string; readonly bytes: Uint8Array; }
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
function text(bytes: Uint8Array): string { const end = bytes.indexOf(0); return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end)); }
function octal(bytes: Uint8Array): number {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error("Runner archive contains an invalid numeric field.");
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) throw new Error("Runner archive numeric field is too large.");
  return result;
}
function pax(bytes: Uint8Array): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    if (space < offset || space - offset > 8) throw new Error("Runner archive metadata is invalid.");
    const sizeText = decoder.decode(bytes.subarray(offset, space));
    if (!/^[1-9]\d*$/u.test(sizeText)) throw new Error("Runner archive metadata is invalid.");
    const size = Number(sizeText);
    if (size <= space - offset + 2 || offset + size > bytes.length || bytes[offset + size - 1] !== 10) throw new Error("Runner archive metadata is invalid.");
    const line = decoder.decode(bytes.subarray(space + 1, offset + size - 1));
    const equals = line.indexOf("=");
    if (equals < 1) throw new Error("Runner archive metadata is invalid.");
    const key = line.slice(0, equals);
    if (Object.hasOwn(fields, key) || !["path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "charset"].includes(key)) throw new Error("Runner archive metadata is invalid.");
    fields[key] = line.slice(equals + 1); offset += size;
  }
  return fields;
}
function safePath(input: string): string {
  if (!input.startsWith("package/") || /[\\:\u0000-\u001f\u007f]/u.test(input)) throw new Error("Runner archive path is invalid.");
  const name = input.slice(8).replace(/\/$/u, "");
  if (!name || name.length > 1024 || posix.normalize(name) !== name
    || name.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error("Runner archive path is invalid.");
  return name;
}

/** Parse the entire authenticated archive before writing anything. No links or special files. */
export function runnerArchiveFiles(compressed: Uint8Array): readonly ReleaseArchiveFile[] {
  const archive = gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED_BYTES });
  const files: ReleaseArchiveFile[] = [];
  const names = new Set<string>();
  let metadata: Record<string, string> | undefined;
  let ended = false;
  for (let offset = 0, count = 0; offset + 512 <= archive.length;) {
    if (++count > 16384) throw new Error("Runner archive contains too many entries.");
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (archive.subarray(offset).some(byte => byte !== 0)) throw new Error("Runner archive has trailing data.");
      ended = true; break;
    }
    const checksum = octal(header.subarray(148, 156));
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== sum) throw new Error("Runner archive header checksum is invalid.");
    const size = octal(header.subarray(124, 136));
    if (size > 16 * 1024 * 1024 || offset + 512 + size > archive.length) throw new Error("Runner archive entry is too large or incomplete.");
    const body = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = header[156];
    if (type === 120) {
      if (metadata !== undefined || size > 16384) throw new Error("Runner archive metadata is invalid.");
      metadata = pax(body); continue;
    }
    if (type !== 0 && type !== 48 && type !== 53) throw new Error("Runner archive contains a link or special file.");
    if (metadata?.size !== undefined && (!/^\d+$/u.test(metadata.size) || Number(metadata.size) !== size)) throw new Error("Runner archive entry size differs from metadata.");
    const prefix = text(header.subarray(345, 500));
    const rawName = metadata?.path ?? (prefix ? `${prefix}/` : "") + text(header.subarray(0, 100));
    metadata = undefined;
    if (type === 53 && rawName === "package/") continue;
    const path = safePath(rawName);
    const folded = path.toLowerCase();
    if (names.has(folded)) throw new Error("Runner archive contains duplicate paths.");
    names.add(folded);
    if (type === 53) { if (size !== 0) throw new Error("Runner archive directory contains data."); continue; }
    if (files.length >= 8192) throw new Error("Runner archive contains too many files.");
    files.push({ path, bytes: body });
  }
  if (!ended || metadata !== undefined || files.length === 0) throw new Error("Runner archive is incomplete.");
  const paths = new Set(files.map(file => file.path.toLowerCase()));
  for (const file of files) {
    let parent = posix.dirname(file.path).toLowerCase();
    while (parent !== ".") { if (paths.has(parent)) throw new Error("Runner archive file overlaps a directory."); parent = posix.dirname(parent); }
  }
  return files;
}
