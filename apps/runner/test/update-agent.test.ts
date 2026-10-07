import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerMaintenanceIdentity } from "../src/maintenance-contract.js";

const testState = vi.hoisted(() => ({ profile: undefined as RunnerMaintenanceIdentity | undefined }));
vi.mock("node:fs/promises", () => ({ lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o600, uid: process.getuid?.() }), realpath: async (path: string) => path }));
vi.mock("../src/profile.js", () => ({ ProfileStore: class { async loadMaintenanceIdentity() { return testState.profile; } } }));
vi.mock("../src/updates/journal.js", () => ({ assertManagerDirectory: async () => {}, FileUpdateJournal: class { async load() { return undefined; } }, loadManagerId: async () => "manager" }));
vi.mock("../src/updates/manager-install.js", () => ({ maintenanceManagerLayout: () => ({ platform: process.platform, mode: "user", managerRoot: "/manager", runtimePath: process.execPath, bundlePath: process.argv[1], layout: { installRoot: "/install", stateRoot: "/state" } }) }));

import { runMaintenanceAgent } from "../src/updates/agent.js";

const identity: RunnerMaintenanceIdentity = { runner_id: "runner", server_url: "wss://example.test/runner/connect", token: "private-token" };
const idle = { operation: null, cloud_drained: true, cloud_uncertain: false, observed_version: null, observed_new_session: false };

describe("maintenance request scheduling", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0); testState.profile = identity; });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function start(respond: (calls: number) => Response) {
    const controller = new AbortController(), errors: string[] = [], tokens: string[] = [];
    let calls = 0;
    const running = runMaintenanceAgent({ profilePath: "/profile", installRoot: "/install", signal: controller.signal,
      onError: code => errors.push(code), fetch: (async (_url, init) => { calls++; tokens.push(new Headers(init?.headers).get("authorization")!); return respond(calls); }) as typeof fetch });
    return { errors, tokens, calls: () => calls, async stop() { controller.abort(); await running; } };
  }

  it.each([429, 503])("honors Retry-After for HTTP %s and returns to idle cadence after recovery", async status => {
    const agent = start(calls => calls === 1 ? new Response("private-response", { status, headers: { "retry-after": "120" } })
      : calls === 3 ? new Response("private-response", { status }) : Response.json(idle));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(agent.calls()).toBe(1);
      expect(agent.errors).toEqual([`maintenance_http_${status}`]);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(agent.calls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(agent.calls()).toBe(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(agent.calls()).toBe(3);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(agent.calls()).toBe(4);
      expect(agent.errors).toEqual([`maintenance_http_${status}`, `maintenance_http_${status}`]);
    } finally { await agent.stop(); }
  });

  it.each([401, 403])("suspends rejected credentials after HTTP %s and resumes after rotation", async status => {
    const agent = start(calls => calls === 1 ? new Response("private-response", { status }) : Response.json(idle));
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(agent.calls()).toBe(1);
      expect(agent.errors).toEqual([`maintenance_http_${status}`]);
      testState.profile = { ...identity, token: "rotated-private-token" };
      await vi.advanceTimersByTimeAsync(30_000);
      expect(agent.calls()).toBe(2);
      expect(agent.tokens).toEqual(["Bearer private-token", "Bearer rotated-private-token"]);
      expect(agent.errors.join(" ")).not.toContain("private");
    } finally { await agent.stop(); }
  });

  it("backs off repeated unavailable requests without flooding identical log messages", async () => {
    const agent = start(() => new Response("private-response", { status: 503 }));
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(agent.calls()).toBe(2);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(agent.calls()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(agent.calls()).toBe(3);
      expect(agent.errors).toEqual(["maintenance_http_503"]);
    } finally { await agent.stop(); }
  });

  it("backs off a network failure without including its native details in diagnostics", async () => {
    const agent = start(() => { throw new TypeError("private-token in native network detail"); });
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(agent.calls()).toBe(2);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(agent.calls()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(agent.calls()).toBe(3); expect(agent.errors).toEqual(["maintenance_unavailable"]);
    } finally { await agent.stop(); }
  });

  it("cancels an outstanding idle request promptly when stopped", async () => {
    const controller = new AbortController(), errors: string[] = [];
    let calls = 0;
    const running = runMaintenanceAgent({ profilePath: "/profile", installRoot: "/install", signal: controller.signal, onError: code => errors.push(code),
      fetch: (async (_url, init) => { calls++; return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true })); }) as typeof fetch });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    controller.abort(); await running;
    expect(errors).toEqual([]); expect(calls).toBe(1);
  });
});
