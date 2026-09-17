/** One bounded observation, never a retry or an authorization grant. */
export async function boundedJsonResponse(fetchResponse: (signal: AbortSignal) => Promise<Response>, timeoutMs = 5000, maxBytes = 16384): Promise<{ readonly status: number; readonly value?: unknown } | undefined> {
  return boundedJsonReceipt(fetchResponse, [200], timeoutMs, maxBytes);
}

/** Status parsing is explicit; callers still decide which receipt grants authority. */
export async function boundedJsonReceipt(fetchResponse: (signal: AbortSignal) => Promise<Response>, acceptedStatuses: readonly number[], timeoutMs = 5000, maxBytes = 16384): Promise<{ readonly status: number; readonly value?: unknown } | undefined> {
  if (!Array.isArray(acceptedStatuses) || acceptedStatuses.length < 1 || acceptedStatuses.length > 16 || acceptedStatuses.some(status => !Number.isInteger(status) || status < 200 || status > 599)) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) return undefined;
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => { controller.abort(); void reader?.cancel().catch(() => undefined); };
  const observe = async (): Promise<{ readonly status: number; readonly value?: unknown } | undefined> => {
    try {
      const response = await fetchResponse(controller.signal);
      if (controller.signal.aborted || performance.now() >= deadline) { cancel(); void response.body?.cancel().catch(() => undefined); return undefined; }
      if (!acceptedStatuses.includes(response.status)) { void response.body?.cancel().catch(() => undefined); return { status: response.status }; }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) { void response.body?.cancel().catch(() => undefined); return undefined; }
      if (response.body === null) return undefined;
      reader = response.body.getReader();
      const bytes = new Uint8Array(maxBytes); let size = 0, emptyChunks = 0;
      for (;;) {
        const next = await reader.read();
        if (controller.signal.aborted || performance.now() >= deadline) { cancel(); return undefined; }
        if (next.done) break;
        // Empty chunks consume no byte budget and can keep resolving in the
        // microtask queue, starving the timer. Bound them without retaining them.
        if (next.value.byteLength === 0) {
          if (++emptyChunks > 1024) { cancel(); return undefined; }
          continue;
        }
        if (next.value.byteLength > maxBytes - size) { cancel(); return undefined; }
        bytes.set(next.value, size); size += next.value.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
      if (controller.signal.aborted || performance.now() >= deadline) { cancel(); return undefined; }
      return { status: response.status, value };
    } catch { return undefined; }
  };
  try {
    return await Promise.race([observe(), new Promise<undefined>(resolve => { timer = setTimeout(() => { cancel(); resolve(undefined); }, timeoutMs); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); cancel(); }
}
