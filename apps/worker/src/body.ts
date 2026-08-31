export async function readCappedBytes(request: Request, maxBytes: number): Promise<Uint8Array | undefined> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await cancelBody(request);
    return undefined;
  }
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await cancelReader(reader);
        return undefined;
      }
      chunks.push(next.value);
    }
  } catch {
    // A failed stream may still hold an underlying source. Best-effort
    // cancellation keeps malformed/disconnected requests from lingering.
    await cancelReader(reader);
    return undefined;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readCappedText(request: Request, maxBytes: number): Promise<string | undefined> {
  const bytes = await readCappedBytes(request, maxBytes);
  if (bytes === undefined) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function readCappedFormData(request: Request, maxBytes: number): Promise<FormData | undefined> {
  const contentTypeHeader = request.headers.get("content-type") ?? "";
  const rawType = contentTypeHeader.split(";", 1)[0] ?? "";
  const contentType = (rawType ?? "").trim().toLowerCase();
  const body = await readCappedBytes(request, maxBytes);
  if (body === undefined) return undefined;
  if (contentType === "application/x-www-form-urlencoded") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      const form = new FormData();
      for (const [key, value] of new URLSearchParams(text)) form.append(key, value);
      return form;
    } catch {
      return undefined;
    }
  }
  if (contentType !== "multipart/form-data") return undefined;
  try {
    // Preserve the complete media-type header. In particular, RFC-compliant
    // quoted boundaries (and semicolons inside a quoted boundary) must not be
    // split or passed through with their quotes stripped incorrectly.
    const headers = new Headers({ "content-type": contentTypeHeader });
    const parsed = await new Request(request.url, { method: "POST", headers, body: body.buffer as ArrayBuffer }).formData();
    for (const value of parsed.values()) if (typeof value !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try { await reader.cancel(); } catch { /* cancellation is best effort */ }
}

async function cancelBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // The body may already be consumed or cancelled.
  }
}
