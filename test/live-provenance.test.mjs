import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLiveProvenance } from "../scripts/check-live-provenance.mjs";

const expected = { commit: "a".repeat(40), branch: "main" };
const health = { ok: true, deployment: { ...expected, tree: "b".repeat(40), schema_version: 1, state: "identified", source: "git_build", build_state: "clean", agreement: "not_comparable", attestation: "self_reported" } };

test("R01 observer makes exactly one no-store request and accepts source without a provider tag", async () => {
  let calls = 0;
  const result = await checkLiveProvenance("https://customer.example", expected, async (url, options) => {
    calls++; assert.equal(url.href, "https://customer.example/health"); assert.equal(options.redirect, "error"); assert.equal(options.cache, "no-store");
    return Response.json(health);
  });
  assert.equal(calls, 1); assert.equal(result.commit, expected.commit); assert.equal(result.evidence, "observed_self_report");
});

test("R01 observer refuses version-only old health, unknown identity, conflicts and the wrong commit", async () => {
  for (const body of [
    { ok: true, worker_version: "0.1.3", deployment: { branch: null, commit: null } },
    { ...health, deployment: { ...health.deployment, state: "conflict" } },
    { ...health, deployment: { ...health.deployment, build_state: "dirty" } },
    { ...health, deployment: { ...health.deployment, commit: "c".repeat(40) } },
    { ...health, deployment: { ...health.deployment, branch: "dev" } },
  ]) await assert.rejects(checkLiveProvenance("https://customer.example", expected, async () => Response.json(body)));
});

test("R01 observer does not forward credentials or accept a secret-bearing URL", async () => {
  let calls = 0;
  for (const origin of ["https://user:password@example.com", "https://example.com/private-token", "https://example.com?secret=x", "http://example.com"]) {
    await assert.rejects(checkLiveProvenance(origin, expected, async () => { calls++; return Response.json(health); }));
  }
  assert.equal(calls, 0);
});

test("R01 observer rejects oversized, malformed and unsuccessful responses without retry", async () => {
  for (const response of [new Response("x".repeat(16385)), new Response("invalid json"), new Response("redirect", { status: 302 }), new Response("failed", { status: 503 })]) {
    let calls = 0;
    await assert.rejects(checkLiveProvenance("https://customer.example", expected, async () => { calls++; return response; }));
    assert.equal(calls, 1);
  }
});

test("R01 observer cancels excessive empty response fragments instead of spinning without a byte budget", async () => {
  let pulls = 0, cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      pulls++;
      if (pulls <= 300) controller.enqueue(new Uint8Array());
      else { controller.enqueue(new TextEncoder().encode(JSON.stringify(health))); controller.close(); }
    },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(checkLiveProvenance("https://customer.example", expected, async () => response));
  assert.ok(pulls <= 258, "read attempts must have an independent bound");
  assert.equal(cancelled, true);
});

test("R01 unsuccessful streaming responses are cancelled rather than left open", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
  await assert.rejects(checkLiveProvenance("https://customer.example", expected, async () => response));
  assert.equal(cancelled, true);
});

test("R01 successful observations explicitly omit browser credentials", async () => {
  await checkLiveProvenance("https://customer.example", expected, async (_url, options) => {
    assert.equal(options.credentials, "omit");
    return Response.json(health);
  });
});

test("R01 an aborted response body is cancelled and cannot become successful empty output", async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const timer = setTimeout(() => controller.abort(new Error("test deadline")), 10);
  try {
    await assert.rejects(checkLiveProvenance("https://customer.example", expected, async () => response));
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});
