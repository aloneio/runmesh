import type { SkillSource, SkillSourcePort } from "../../contracts/skill-source.js";
import { readGithubTar } from "./github-tar.js";

type Result = Awaited<ReturnType<SkillSourcePort["read"]>> | { readonly state: "fallback" };
const COMPRESSED_LIMIT = 8_388_608, EXPANDED_LIMIT = 33_554_432;
const ARCHIVE_DEADLINE_MS = 9000;

/** Bounded stream collector shared by compressed and decompressed bodies.
 * A limit violation aborts the source; no partial bundle is ever returned. */
async function collect(reader: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const handle = reader.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void handle.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const part = await handle.read();
      if (signal.aborted) break;
      if (part.done) {
        const result = new Uint8Array(size);
        let index = 0;
        for (const chunk of chunks) { result.set(chunk, index); index += chunk.byteLength; }
        return result;
      }
      if (part.value.byteLength > limit - size) throw new Error("archive_limit");
      size += part.value.byteLength;
      chunks.push(part.value);
    }
    throw new Error("archive_cancelled");
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    try { handle.releaseLock(); } catch { /* A pending cancellation may settle later. */ }
  }
}

/** One immutable codeload response replaces dozens of raw-file subrequests.
 * Unsupported/large archives fall back to the existing Git tree source;
 * invalid selected entries never bypass the strict Skill content checks. */
export async function readGithubArchive(send: typeof fetch, source: SkillSource, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) return { state: "unavailable" };
  const repo = source.repository.slice("https://github.com/".length);
  const url = "https://codeload.github.com/" + repo + "/tar.gz/" + source.commit;
  // Explicitly clear the transport deadline after a fast response; a pending
  // timer must not keep a dormant Durable Object active for nine seconds.
  const timeoutController = new AbortController();
  const cancel = () => timeoutController.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, ARCHIVE_DEADLINE_MS);
  const requestSignal = timeoutController.signal;
  try {
    // Cloudflare Workers cannot use redirect: "error" or cache: "no-store".
    // Manual redirects are rejected by the explicit status === 200 check.
    const response = await send(url, { method: "GET", redirect: "manual", credentials: "omit",
      signal: requestSignal, headers: { accept: "application/gzip", "user-agent": "Runmesh-Skill-Import" } });
    const reject = () => { void response.body?.cancel().catch(() => undefined); };
    if (response.status !== 200 || !response.body) { reject(); return { state: "fallback" }; }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > COMPRESSED_LIMIT)) {
      reject(); return { state: "fallback" };
    }
    const compressed = await collect(response.body, COMPRESSED_LIMIT, requestSignal);
    if (compressed.length < 2 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) return { state: "fallback" };
    const stream = new ReadableStream<BufferSource>({
      start(controller) { controller.enqueue(new Uint8Array(compressed)); controller.close(); },
    }).pipeThrough(new DecompressionStream("gzip"));
    const expanded = await collect(stream, EXPANDED_LIMIT, requestSignal);
    if (requestSignal.aborted) return { state: "unavailable" };
    return readGithubTar(expanded, source);
  } catch {
    return signal.aborted ? { state: "unavailable" } : { state: "fallback" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}
