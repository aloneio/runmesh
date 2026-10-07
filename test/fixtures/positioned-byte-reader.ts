import type { FileHandle } from "node:fs/promises";
import { readPageBytes, type PositionedByteReader } from "../../apps/runner/src/page-read.js";

declare const nativeFile: FileHandle;
const nativeReader: PositionedByteReader = nativeFile;
void readPageBytes(nativeReader, 0, 16, "file_changed");

const reader: PositionedByteReader = {
  async read(buffer, offset, length, position) {
    buffer.fill(position, offset, offset + length);
    return { bytesRead: length };
  },
};
void readPageBytes(reader, 0, 16, "log_changed");

// @ts-expect-error Reading bytes does not grant file mutation.
void reader.write(Buffer.alloc(1));
// @ts-expect-error The adapter owns metadata inspection.
void reader.stat();
// @ts-expect-error The adapter owns the file handle lifetime.
void reader.close();
