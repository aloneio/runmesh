import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { failureMetadata, isKnownRpcFailureCode, RPC_FAILURE_CODES } from "@aloneio/runmesh-protocol";
import { REMOTE_CODES, remoteFailureMetadata } from "../../apps/worker/src/contracts/remote.js";

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sources(join(directory, entry.name)) : Promise.resolve(entry.name.endsWith(".ts") ? [join(directory, entry.name)] : [])))).flat();
}
it("all literal Runner and MCP failure codes belong to the shared classified catalog", async () => {
  const files = (await Promise.all(["apps/runner/src", "apps/worker/src/mcp"].map(path => sources(fileURLToPath(new URL(`../../${path}`, import.meta.url)))))).flat();
  let checked = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/(?:new (?:RpcRuntimeError|PathPolicyError)|\b(?:fail|failure|failWithDetails|failureWithDetails))\(\s*["']([a-z_0-9]+)["']/g)) {
      checked++;
      expect(isKnownRpcFailureCode(match[1]), `${file}: ${match[1]}`).toBe(true);
    }
  }
  expect(checked).toBeGreaterThan(100);
});
it("central remote failures have an independently complete catalog without extending Runner wire errors", async () => {
  const files = await sources(fileURLToPath(new URL("../../apps/worker/src", import.meta.url)));
  let checked = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/(?:new RemoteFault|\bremoteFailure)\(\s*["']([a-z_0-9]+)["']/g)) {
      checked++;
      expect(REMOTE_CODES.includes(match[1] as typeof REMOTE_CODES[number]), `${file}: ${match[1]}`).toBe(true);
    }
  }
  expect(checked).toBeGreaterThan(25);
  for (const code of REMOTE_CODES) for (const state of ["not_started", "unknown", "completed"] as const) {
    const result = remoteFailureMetadata(code, state);
    expect(result.code).toBe(`remote_${code}`);
    expect(result.failure_class.length).toBeGreaterThan(0);
    expect(Object.isFrozen(result)).toBe(true);
    if (state !== "not_started") { expect(result.next_action).toBe("inspect_upstream_state"); expect(result.operation_state).not.toBe("not_started"); }
  }
  expect(Object.isFrozen(REMOTE_CODES)).toBe(true);
});

it("unknown central errors are not reflected and cannot establish non-execution", () => {
  for (const code of ["constructor", "__proto__", "private-error-detail"]) {
    const result = remoteFailureMetadata(code, "not_started");
    expect(result).toMatchObject({ code: "remote_result_unconfirmed", operation_state: "unknown", next_action: "inspect_upstream_state" });
    expect(JSON.stringify(result)).not.toContain(code);
  }
});

describe("replay safety across all classified errors", () => {
  it.each(["unknown", "running", "committed"] as const)("never recommends automatic replay for observed state %s", state => {
    for (const code of RPC_FAILURE_CODES) {
      const result = failureMetadata(code, state);
      expect(result.next_action, code).not.toMatch(/retry/);
      expect(result.retry_after_ms, code).toBeUndefined();
      expect(result.operation_state, code).not.toBe("not_started");
    }
  });
  it("does not downgrade partial mutation outcomes to an unstarted operation", () => {
    expect(failureMetadata("context_prune_partial", "not_started").operation_state).toBe("unknown");
  });
  it("does not share mutable policy objects or trust inherited property names", () => {
    expect(Object.isFrozen(RPC_FAILURE_CODES)).toBe(true);
    expect(Object.isFrozen(failureMetadata("busy"))).toBe(true);
    for (const code of ["constructor", "__proto__", "future_code"]) {
      expect(isKnownRpcFailureCode(code)).toBe(false);
      expect(failureMetadata(code)).toEqual({ failure_class: "unknown", operation_state: "unknown", next_action: "contact_operator" });
    }
  });
});
