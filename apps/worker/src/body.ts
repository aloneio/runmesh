// This covers upload consumption only, before dispatch. Foreground operations
// keep their own execution budget; a slow client cannot hold an upload forever.
const BODY_READ_TIMEOUT_MS = 30_000;

export async function readCappedBytes(request: Request, maxBytes: number, timeoutMs = BODY_READ_TIMEOUT_MS): Promise<Uint8Array | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BODY_READ_TIMEOUT_MS) {
    cancelBody(request);
    return undefined;
  }
  const length = request.headers.get("content-length");
  if (request.signal.aborted || (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))) {
    cancelBody(request);
    return undefined;
  }
  if (request.body === null) return new Uint8Array(0);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = request.body.getReader(); } catch { return undefined; }
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const expired = (): boolean => stopped || request.signal.aborted || performance.now() >= deadline;
  const cancel = (): void => { stopped = true; cancelReader(reader); };
  let abort: () => void = cancel;
  const observe = async (): Promise<Uint8Array | undefined> => {
    // Grow one buffer instead of retaining arbitrarily many tiny chunk objects.
    let bytes = new Uint8Array(0), size = 0, emptyChunks = 0;
    try {
      for (;;) {
        if (expired()) return undefined;
        const next = await reader.read();
        if (expired()) return undefined;
        if (next.done) return bytes.slice(0, size);
        if (!(next.value instanceof Uint8Array) || next.value.byteLength > maxBytes - size) return undefined;
        if (next.value.byteLength === 0) {
          if (++emptyChunks > 1024) return undefined;
          continue;
        }
        const needed = size + next.value.byteLength;
        if (needed > bytes.byteLength) {
          const grown = new Uint8Array(Math.min(maxBytes, Math.max(16_384, needed, bytes.byteLength * 2)));
          grown.set(bytes.subarray(0, size)); bytes = grown;
        }
        bytes.set(next.value, size); size = needed;
      }
    } catch { return undefined; }
  };
  try {
    return await Promise.race([observe(), new Promise<undefined>(resolve => {
      abort = () => { cancel(); resolve(undefined); };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      else timer = setTimeout(abort, timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    cancel();
    try { reader.releaseLock(); } catch { /* pending read settles after cancellation */ }
  }
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

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try { void reader.cancel().catch(() => undefined); } catch { /* cancellation is best effort */ }
}

function cancelBody(request: Request): void {
  try {
    void request.body?.cancel().catch(() => undefined);
  } catch {
    // The body may already be consumed or cancelled.
  }
}
