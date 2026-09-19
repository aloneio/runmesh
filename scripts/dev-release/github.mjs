import assert from "node:assert/strict";

/** Fixed-origin, bounded GitHub API adapter. A real 404 alone means absent;
 * authentication, throttling and transport failures never authorize creation. */
export async function githubJson(path, { method = "GET", body, missing = false, token = process.env.GH_TOKEN, fetchImpl = fetch } = {}) {
  assert.ok(typeof token === "string" && token.length > 0, "GitHub token is required");
  assert.ok(typeof path === "string" && /^[A-Za-z0-9_./?=&%+:-]+$/u.test(path) && !path.startsWith("/") && !path.includes(".."));
  const response = await fetchImpl(`https://api.github.com/repos/aloneio/runmesh/${path}`, {
    method, redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(30000),
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 404 && missing) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub ${method} failed with HTTP ${response.status}`); }
  assert.ok(response.body);
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    for (let index = 0; ; index++) {
      assert.ok(index < 2048, "GitHub response fragment limit");
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; assert.ok(bytes <= 1024 * 1024, "GitHub response byte limit"); chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
