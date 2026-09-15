import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

/** One explicit read, no polling or remote mutation. The observed statement
 * is self-reported build identity, never a replacement for release signatures.
 */
export async function checkLiveProvenance(origin, expected, fetchImpl = fetch) {
  const url = new URL(origin);
  assert.ok(url.protocol === "https:" && url.origin === origin, "Use an exact HTTPS origin without credentials, path or query");
  assert.ok(expected && /^[a-f0-9]{40}$/u.test(expected.commit) && ["main", "dev"].includes(expected.branch), "Supply the expected full commit and main|dev branch");
  const signal = AbortSignal.timeout(10000);
  const response = await fetchImpl(new URL("/health", url), { redirect: "error", cache: "no-store", credentials: "omit", headers: { accept: "application/json", "cache-control": "no-store" }, signal });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Health request was not successful");
  }
  assert.ok(response.body, "Missing health body");
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0, reads = 0;
  // Abort native and injected streams, including a stalled read. The same
  // request deadline covers the body; byte limits alone do not bound empty
  // chunks or an indefinitely open response.
  const abortBody = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abortBody, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      if (++reads > 256) throw new Error("Health response exceeds the fragment budget");
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 16384) throw new Error("Health response exceeds the 16 KiB budget");
      chunks.push(item.value);
    }
  } finally {
    signal.removeEventListener("abort", abortBody);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  const source = result?.deployment;
  assert.ok(result?.ok === true && source?.schema_version === 1 && source.state === "identified" && source.source === "git_build" && source.build_state === "clean", "Deployment source is not identified");
  assert.ok(source.commit === expected.commit && source.branch === expected.branch && /^[a-f0-9]{40}$/u.test(source.tree), "Deployed source does not match the expected source");
  assert.ok(["matched", "not_comparable"].includes(source.agreement) && source.attestation === "self_reported", "Conflicting or unknown provenance semantics");
  return { verified: true, evidence: "observed_self_report", commit: source.commit, tree: source.tree, branch: source.branch, agreement: source.agreement, response_bytes: bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 5, "Use check:deployment -- <https-origin> <full-commit> <main|dev>");
    console.log(JSON.stringify(await checkLiveProvenance(process.argv[2], { commit: process.argv[3], branch: process.argv[4] })));
  } catch {
    console.error("deployment_provenance_unverified: health did not confirm the expected clean source; no deployment or retry was performed");
    process.exitCode = 1;
  }
}
