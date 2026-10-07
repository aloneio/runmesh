import { createHash } from "node:crypto";

/** Parse only the data needed to project an index's single shared dependency.
 * Entries and extensions stay opaque to the Runner and are interpreted by Git. */
export function sharedIndexName(index: Buffer, hashBytes: 20 | 32): string | undefined {
  const end = index.length - hashBytes;
  if (end < 12 || index.toString("ascii", 0, 4) !== "DIRC") throw new Error("Git index header is malformed");
  const version = index.readUInt32BE(4), entries = index.readUInt32BE(8);
  if (version < 2 || version > 4) throw new Error("Git index version is invalid");
  let offset = 12;
  for (let entry = 0; entry < entries; entry += 1) {
    const start = offset, flagsAt = offset + 40 + hashBytes;
    if (flagsAt + 2 > end) throw new Error("Git index entry is truncated");
    const flags = index.readUInt16BE(flagsAt);
    offset = flagsAt + 2;
    if ((flags & 0x4000) !== 0) {
      if (version < 3 || offset + 2 > end) throw new Error("Git index entry flags are malformed");
      offset += 2;
    }
    if (version === 4) {
      let width = 0;
      do {
        if (offset >= end || ++width > 10) throw new Error("Git index path prefix is malformed");
      } while ((index[offset++]! & 0x80) !== 0);
    }
    const nul = index.indexOf(0, offset);
    if (nul < 0 || nul >= end) throw new Error("Git index path is truncated");
    offset = version === 4 ? nul + 1 : start + Math.ceil((nul + 1 - start) / 8) * 8;
    if (offset > end) throw new Error("Git index entry padding is truncated");
  }
  let dependency: string | undefined, linked = false;
  while (offset < end) {
    if (offset + 8 > end) throw new Error("Git index extension is truncated");
    const signature = index.toString("ascii", offset, offset + 4), size = index.readUInt32BE(offset + 4);
    offset += 8;
    if (size > end - offset) throw new Error("Git index extension size is invalid");
    if (signature === "link") {
      if (linked || size < hashBytes) throw new Error("Git shared index link is malformed");
      linked = true;
      const digest = index.subarray(offset, offset + hashBytes);
      if (digest.some(byte => byte !== 0)) dependency = `sharedindex.${digest.toString("hex")}`;
    }
    offset += size;
  }
  return dependency;
}

export function validateSharedIndex(index: Buffer, name: string, hashBytes: 20 | 32): void {
  if (sharedIndexName(index, hashBytes) !== undefined) throw new Error("Git shared index contains another dependency");
  const expected = name.slice("sharedindex.".length);
  const digest = createHash(hashBytes === 32 ? "sha256" : "sha1").update(index.subarray(0, -hashBytes)).digest("hex");
  if (digest !== expected || index.subarray(-hashBytes).toString("hex") !== expected) throw new Error("Git shared index checksum does not match its reference");
}

export function validateShallowBoundary(value: Buffer, hashBytes: 20 | 32): void {
  if (value.length === 0) return;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const hash = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (hash.length !== hashBytes * 2 || !/^[0-9a-f]+$/iu.test(hash)) throw new Error("Git shallow boundary is malformed");
  }
}
