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
        await reader.cancel();
        return undefined;
      }
      chunks.push(next.value);
    }
  } catch {
    return undefined;
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
  const [rawType, ...parameters] = contentTypeHeader.split(";");
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
  const boundary = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.toLowerCase().startsWith("boundary="))?.slice("boundary=".length).trim();
  if (boundary === undefined || boundary.length === 0) return undefined;
  try {
    const headers = new Headers({ "content-type": `multipart/form-data; boundary=${boundary}` });
    const parsed = await new Request(request.url, { method: "POST", headers, body: body.buffer as ArrayBuffer }).formData();
    for (const value of parsed.values()) if (typeof value !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function cancelBody(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // The body may already be consumed or cancelled.
  }
}
