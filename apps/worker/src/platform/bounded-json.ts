/** One bounded observation, never a retry or an authorization grant. */
export async function boundedJsonResponse(fetchResponse: (signal: AbortSignal) => Promise<Response>, timeoutMs = 5000, maxBytes = 16384): Promise<{ readonly status: number; readonly value?: unknown } | undefined> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) return undefined;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => { controller.abort(); void reader?.cancel().catch(() => undefined); };
  const observe = async (): Promise<{ readonly status: number; readonly value?: unknown } | undefined> => {
    try {
      const response = await fetchResponse(controller.signal);
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); return undefined; }
      if (response.status !== 200) { void response.body?.cancel().catch(() => undefined); return { status: response.status }; }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) { void response.body?.cancel().catch(() => undefined); return undefined; }
      if (response.body === null) return undefined;
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const next = await reader.read();
        if (controller.signal.aborted) return undefined;
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) { cancel(); return undefined; }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { status: response.status, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
    } catch { return undefined; }
  };
  try {
    return await Promise.race([observe(), new Promise<undefined>(resolve => { timer = setTimeout(() => { cancel(); resolve(undefined); }, timeoutMs); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); cancel(); }
}
