import assert from "node:assert/strict";

/** Fixed-origin, bounded GitHub API adapter. A real 404 alone means absent;
 * authentication, throttling and transport failures never authorize creation. */
export async function githubJson(path, { method = "GET", body, missing = false, token = process.env.GH_TOKEN, fetchImpl = fetch } = {}) {
  assert.ok(typeof token === "string" && token.length > 0, "GitHub token is required");
  assert.ok(typeof path === "string" && /^[A-Za-z0-9_./?=&%+:-]+$/u.test(path) && !path.startsWith("/") && !path.includes(".."));
  const signal = AbortSignal.timeout(30000);
  const response = await fetchImpl(`https://api.github.com/repos/aloneio/runmesh/${path}`, {
    method, redirect: "error", cache: "no-store", credentials: "omit", signal,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // A transport may ignore the timeout and resolve later. The retired
  // operation must not inspect or dispose the late response body.
  signal.throwIfAborted();
  if (response.status === 404 && missing) { void response.body?.cancel().catch(() => undefined); return null; }
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error(`GitHub ${method} failed with HTTP ${response.status}`); }
  assert.ok(response.body);
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  let pendingRead; let readSettled = false;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  const release = () => { try { reader.releaseLock(); } catch { /* a read may still be pending */ } };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (let index = 0; ; index++) {
      assert.ok(index < 2048, "GitHub response fragment limit");
      const read = reader.read(); pendingRead = read; readSettled = false;
      let onAbort;
      const interrupted = new Promise((_, reject) => { onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")); signal.addEventListener("abort", onAbort, { once: true }); });
      let part;
      try { part = await Promise.race([read, interrupted]); readSettled = true; }
      finally { signal.removeEventListener("abort", onAbort); if (readSettled) pendingRead = undefined; }
      signal.throwIfAborted(); if (part.done) break;
      bytes += part.value.byteLength; assert.ok(bytes <= 1024 * 1024, "GitHub response byte limit"); chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", abort); void reader.cancel().catch(() => undefined);
    const read = pendingRead;
    if (read !== undefined && !readSettled) void read.then(release, release); else release();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
