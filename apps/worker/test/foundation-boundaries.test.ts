import { expect, it } from "vitest";
import { canonicalPublicOrigin, resolvePublicOrigin } from "../src/public-origin.js";
import * as installer from "../src/installer.js";
import { resolveRuntimeConfiguration } from "../src/runtime-config.js";
import type { WorkerEnv as OldEnv } from "../src/runner-do.js";
import type { WorkerEnv } from "../src/platform/env.js";
import type { PolicyReadiness as OldReadiness } from "../src/registry.js";
import type { PolicyReadiness } from "../src/contracts/runner-selection.js";

// Type-only compatibility checks; no DO class is instantiated by these tests.
type Same<A, B> = [A, B] extends [B, A] ? true : false;
const envCompatible: Same<OldEnv, WorkerEnv> = true;
const readinessCompatible: Same<OldReadiness, PolicyReadiness> = true;
it("AR03 preserves legacy type exports and the exact origin function objects", () => {
  expect(envCompatible && readinessCompatible).toBe(true);
  expect(installer.canonicalPublicOrigin).toBe(canonicalPublicOrigin);
  expect(installer.resolvePublicOrigin).toBe(resolvePublicOrigin);
});
it.each(["http://example.com", "https://user:secret@example.com", "https://example.com/a", "https://example.com?q=secret", "https://example.com#bad", "https://example.com\\bad", "https://example.com/%0a"])("AR03 origin extraction preserves rejection of %s", value => {
  expect(() => canonicalPublicOrigin(value)).toThrow();
});
it("AR03 domain/proxy resolution and explicit invalid overrides are unchanged", () => {
  const request = new Request("https://custom.example.com/health", { headers: { host: "custom.example.com", "x-forwarded-host": "attacker.invalid" } });
  expect(resolvePublicOrigin(request)).toBe("https://custom.example.com");
  expect(resolvePublicOrigin(request, "https://configured.example.com")).toBe("https://custom.example.com");
  expect(resolvePublicOrigin(new Request("http://internal.test/health", { headers: { host: "configured.example.com" } }), "https://configured.example.com")).toBe("https://configured.example.com");
  expect(() => resolvePublicOrigin(request, "")).toThrow();
  expect(() => resolvePublicOrigin(new Request("https://custom.example.com/", { headers: { host: "attacker.invalid" } }))).toThrow();
});
it("AR03 configuration defaults do not inspect bindings or enable explicit disabled installation", () => {
  const inaccessible = new Proxy({}, { get() { throw new Error("no binding access"); } });
  const input = { HISTORY_DB: inaccessible, RUNMESH_SIGNED_RELEASE_AVAILABLE: "" };
  const result = resolveRuntimeConfiguration(input);
  expect(result.RUNMESH_SIGNED_RELEASE_AVAILABLE).toBe("");
  expect(result.RUNMESH_JOB_HISTORY_BACKEND).toBe("d1");
  expect(result.HISTORY_DB === inaccessible).toBe(true);
  expect(input.RUNMESH_SIGNED_RELEASE_AVAILABLE).toBe("");
});
