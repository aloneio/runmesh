import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerMaintenanceIdentity } from "../src/maintenance-contract.js";
import type { UpdateCoordinatorOptions, UpdateJournalRecord } from "../src/updates/contracts.js";
import { UpdateFailure } from "../src/updates/contracts.js";

const testState = vi.hoisted(() => ({ profile: undefined as RunnerMaintenanceIdentity | undefined, failStateDirectory: false,
  journal: undefined as UpdateJournalRecord | undefined, journalReads: 0, failJournalReadAt: 0, journalCompletes: 0, leaseReleases: 0,
  leaseHeld: false, leaseAcquisitions: 0, releaseFailure: undefined as Error | undefined,
  runCoordinator: undefined as ((options: UpdateCoordinatorOptions) => Promise<void>) | undefined }));
vi.mock("node:fs/promises", () => ({ lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o600, uid: process.getuid?.() }), realpath: async (path: string) => path }));
vi.mock("../src/profile.js", () => ({ ProfileStore: class { async loadMaintenanceIdentity() { return testState.profile; } } }));
vi.mock("../src/updates/journal.js", () => ({ assertManagerDirectory: async (_path: string, create = false) => { if (create && testState.failStateDirectory) throw new Error("manager state directory fixture"); }, FileUpdateJournal: class {
  async load() { testState.journalReads++; if (testState.failJournalReadAt && testState.journalReads >= testState.failJournalReadAt) throw new Error("journal read fixture"); return testState.journal; }
  async complete() { testState.journalCompletes++; testState.journal = undefined; }
  async save(journal: UpdateJournalRecord) { testState.journal = journal; }
}, loadManagerId: async () => "manager" }));
vi.mock("../src/updates/manager-install.js", () => ({ maintenanceManagerLayout: () => ({ platform: process.platform, mode: "user", managerRoot: "/manager", runtimePath: process.execPath, bundlePath: process.argv[1], layout: { installRoot: "/install", stateRoot: "/state" } }) }));
vi.mock("../src/updates/installation-lock.js", () => ({ acquireInstallationLock: async () => {
  testState.leaseAcquisitions++;
  if (testState.leaseHeld) return undefined;
  testState.leaseHeld = true;
  return { assertHeld() { if (!testState.leaseHeld) throw new Error("fixture lease released"); }, async release() {
    testState.leaseReleases++;
    if (testState.releaseFailure !== undefined) throw testState.releaseFailure;
    testState.leaseHeld = false;
  } };
} }));
vi.mock("../src/updates/native-service.js", () => ({ createNativeServiceMaintenance: () => ({}) }));
vi.mock("../src/updates/coordinator.js", () => ({ UpdateCoordinator: class {
  constructor(private readonly options: UpdateCoordinatorOptions) {}
  async runOnce() { if (testState.runCoordinator) await testState.runCoordinator(this.options); else await this.options.recoveryIdentity(); }
} }));

import { runMaintenanceAgent } from "../src/updates/agent.js";

const identity: RunnerMaintenanceIdentity = { runner_id: "runner", server_url: "wss://example.test/runner/connect", token: "private-token" };
const idle = { operation: null, cloud_drained: true, cloud_uncertain: false, observed_version: null, observed_new_session: false };
const operation = { operation_id: "upgrade_1", lifecycle_id: "lifecycle_1", target_version: "0.1.6", target_channel: "stable" as const, manifest_sha256: "a".repeat(64), artifact_sha256: "b".repeat(64), original_version: "0.1.7", manager_id: null, state: "queued" as const, error_code: null, created_at_ms: 1, updated_at_ms: 1 };
const pending = (phase: "preparing" | "checking" | "succeeded"): UpdateJournalRecord => phase === "preparing"
  ? { schema_version: 1, phase, operation, manager_id: "manager" }
  : { schema_version: 1, phase, operation: { ...operation, manager_id: "manager", state: "checking" }, manager_id: "manager", previous: { version: "0.1.7", directory: "/versions/old" }, service: { schema_version: 1, platform: "linux", mode: "user", registered: true, active: true, enabled: true, enablement: "enabled" } };

describe("maintenance request scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0); testState.profile = identity; testState.failStateDirectory = false;
    testState.journal = undefined; testState.journalReads = 0; testState.failJournalReadAt = 0; testState.journalCompletes = 0; testState.leaseReleases = 0; testState.runCoordinator = undefined;
    testState.leaseHeld = false; testState.leaseAcquisitions = 0; testState.releaseFailure = undefined;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function start(respond: (calls: number) => Response) {
    const controller = new AbortController(), errors: string[] = [], tokens: string[] = [];
    let calls = 0, settled = false; let failure: unknown;
    const running = runMaintenanceAgent({ profilePath: "/profile", installRoot: "/install", signal: controller.signal,
      onError: code => errors.push(code), fetch: (async (_url, init) => { calls++; tokens.push(new Headers(init?.headers).get("authorization")!); return respond(calls); }) as typeof fetch });
    const completed = running.then(() => { settled = true; }, cause => { settled = true; failure = cause; });
    return { errors, tokens, calls: () => calls, settled: () => settled, failure: () => failure, async stop(expectedFailure = false) { controller.abort(); await completed; if (!expectedFailure && failure !== undefined) throw failure; } };
  }

  it.each(["completed", "failed"] as const)("exits for native restart when lease release fails after a %s update attempt", async outcome => {
    const signals = ["SIGINT", "SIGTERM"] as const, before = signals.map(signal => process.listeners(signal));
    const saved = pending(outcome === "completed" ? "succeeded" : "checking"); testState.journal = saved;
    const failure = Object.freeze(Object.assign(new Error("fixture lock unlink failed"), { code: "EIO" }));
    testState.releaseFailure = failure;
    let attempts = 0;
    testState.runCoordinator = async options => {
      attempts++;
      if (outcome === "failed") throw new UpdateFailure("activation_failed");
      await options.journal.complete(saved);
    };
    const agent = start(() => Response.json({ ...idle, operation }));
    try {
      await vi.advanceTimersByTimeAsync(90_000);
      expect(agent.settled()).toBe(true); expect(agent.failure()).toBe(failure);
      expect(attempts).toBe(1); expect(testState.leaseAcquisitions).toBe(1); expect(testState.leaseReleases).toBe(1);
      expect(testState.leaseHeld).toBe(true); expect(agent.calls()).toBe(0);
      expect(testState.journal).toBe(outcome === "completed" ? undefined : saved);
      expect(testState.journalCompletes).toBe(outcome === "completed" ? 1 : 0);
      expect(agent.errors).toEqual(outcome === "completed" ? [] : ["activation_failed"]);
      expect(signals.map(signal => process.listeners(signal))).toEqual(before);
    } finally { await agent.stop(true); }
  });

  it("keeps lease release failure observable when shutdown interrupts an update", async () => {
    const signals = ["SIGINT", "SIGTERM"] as const, before = signals.map(signal => process.listeners(signal));
    const saved = pending("checking"); testState.journal = saved;
    const failure = new Error("fixture lock release failed during shutdown"); testState.releaseFailure = failure;
    testState.runCoordinator = async options => new Promise<void>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
    });
    const agent = start(() => Response.json(idle));
    await vi.advanceTimersByTimeAsync(0);
    expect(testState.leaseHeld).toBe(true);
    await agent.stop(true);
    expect(agent.settled()).toBe(true); expect(agent.failure()).toBe(failure);
    expect(testState.leaseReleases).toBe(1); expect(testState.journal).toBe(saved); expect(testState.journalCompletes).toBe(0);
    expect(agent.calls()).toBe(0); expect(agent.errors).toEqual([]);
    expect(signals.map(signal => process.listeners(signal))).toEqual(before);
  });

  it.each(["runner", "server"] as const)("preserves old journals across an actual coordinator restart with a changed %s", async changed => {
    const { UpdateCoordinator } = await vi.importActual<typeof import("../src/updates/coordinator.js")>("../src/updates/coordinator.js");
    for (const phase of ["preparing", "succeeded"] as const) {
      testState.profile = identity; testState.journal = pending(phase);
      testState.runCoordinator = async options => {
        testState.journal = { ...pending(phase), authority_identity: await options.authorityIdentity(), recovery_identity: await options.recoveryIdentity() };
      };
      const old = start(() => Response.json(idle));
      await vi.advanceTimersByTimeAsync(0); await old.stop();
      const saved = structuredClone(testState.journal);
      testState.profile = { ...identity, ...(changed === "runner" ? { runner_id: "replacement" } : { server_url: "wss://replacement.example.test/runner/connect" }) };
      testState.runCoordinator = async options => new UpdateCoordinator(options).runOnce();
      const restarted = start(() => Response.json(idle));
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(restarted.calls()).toBe(0); expect(restarted.errors).toEqual(["invalid_installation"]);
        expect(testState.journal).toEqual(saved); expect(testState.journalCompletes).toBe(0);
      } finally { await restarted.stop(); }
    }
  });

  it("keeps the authority stable while refreshing the credential fingerprint on token rotation", async () => {
    testState.journal = pending("preparing");
    const identities: { authority: string; credential: string }[] = [];
    testState.runCoordinator = async options => { identities.push({ authority: await options.authorityIdentity(), credential: await options.recoveryIdentity() }); };
    const agent = start(() => Response.json(idle));
    try {
      await vi.advanceTimersByTimeAsync(0); testState.profile = { ...identity, token: "rotated-token" };
      await vi.advanceTimersByTimeAsync(30_000);
      expect(identities).toHaveLength(2); expect(identities[1]!.authority).toBe(identities[0]!.authority);
      expect(identities[1]!.credential).not.toBe(identities[0]!.credential); expect(agent.errors).toEqual([]);
    } finally { await agent.stop(); }
  });

  it.each(["runner", "server"])("exits for a native restart after an idle %s identity change", async changed => {
    const signals = ["SIGINT", "SIGTERM"] as const, before = signals.map(signal => process.listeners(signal));
    const agent = start(() => Response.json(idle));
    try {
      await vi.advanceTimersByTimeAsync(0);
      testState.profile = { ...identity, ...(changed === "runner" ? { runner_id: "replacement" } : { server_url: "wss://replacement.example.test/runner/connect" }) };
      await vi.advanceTimersByTimeAsync(30_000);
      expect(agent.settled()).toBe(true);
      expect(agent.failure()).toMatchObject({ code: "invalid_installation" });
      expect(agent.calls()).toBe(1); expect(testState.journalCompletes).toBe(0);
      expect(signals.map(signal => process.listeners(signal))).toEqual(before);
      const restarted = start(() => Response.json(idle));
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(restarted.calls()).toBe(1); expect(restarted.settled()).toBe(false);
        expect(restarted.failure()).toBeUndefined();
      } finally { await restarted.stop(); }
    } finally { await agent.stop(true); }
  });

  it("releases its lease and exits even when the coordinator wraps an identity change", async () => {
    testState.runCoordinator = async options => {
      testState.profile = { ...identity, runner_id: "replacement" };
      try { await options.recoveryIdentity(); } catch { throw new UpdateFailure("activation_failed"); }
    };
    const agent = start(() => Response.json({ ...idle, operation }));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(agent.settled()).toBe(true);
      expect(agent.failure()).toMatchObject({ code: "invalid_installation" });
      expect(testState.leaseReleases).toBe(1); expect(testState.journalCompletes).toBe(0); expect(agent.calls()).toBe(1);
    } finally { await agent.stop(true); }
  });

  it.each(["preparing", "checking", "succeeded"] as const)("keeps the original identity while a %s journal remains, then exits after it is cleared", async phase => {
    const journal = pending(phase); testState.journal = journal;
    const agent = start(() => Response.json(idle));
    try {
      await vi.advanceTimersByTimeAsync(0);
      testState.profile = { ...identity, runner_id: "replacement" };
      await vi.advanceTimersByTimeAsync(300_000);
      expect(agent.settled()).toBe(false); expect(agent.calls()).toBe(0);
      expect(testState.journal).toBe(journal); expect(testState.journalCompletes).toBe(0);
      expect(testState.leaseReleases).toBeGreaterThan(1);
      testState.journal = undefined;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(agent.settled()).toBe(true); expect(agent.failure()).toMatchObject({ code: "invalid_installation" });
      expect(agent.calls()).toBe(0); expect(testState.journalCompletes).toBe(0);
    } finally { await agent.stop(true); }
  });

  it("retains the original identity when the post-change journal check fails", async () => {
    const agent = start(() => Response.json(idle));
    try {
      await vi.advanceTimersByTimeAsync(0);
      testState.profile = { ...identity, runner_id: "replacement" };
      testState.failJournalReadAt = testState.journalReads + 2;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(agent.settled()).toBe(false); expect(agent.calls()).toBe(1); expect(testState.journalCompletes).toBe(0);
      testState.failJournalReadAt = 0;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(agent.settled()).toBe(true); expect(agent.failure()).toMatchObject({ code: "invalid_installation" });
    } finally { await agent.stop(true); }
  });

  it("resumes the old transaction after its original identity is restored", async () => {
    const journal = pending("checking"); testState.journal = journal;
    const agent = start(() => Response.json(idle));
    try {
      await vi.advanceTimersByTimeAsync(0);
      testState.profile = { ...identity, runner_id: "replacement" };
      await vi.advanceTimersByTimeAsync(30_000);
      expect(agent.settled()).toBe(false); expect(testState.journal).toBe(journal);
      testState.profile = { ...identity, token: "restored-identity-token" };
      testState.runCoordinator = async options => {
        await options.recoveryIdentity(); await options.journal.complete(journal);
        testState.runCoordinator = undefined;
        throw new UpdateFailure("local_state_invalid");
      };
      await vi.advanceTimersByTimeAsync(300_000);
      expect(agent.settled()).toBe(false); expect(agent.failure()).toBeUndefined();
      expect(testState.journalCompletes).toBe(1); expect(testState.journal).toBeUndefined();
      expect(agent.tokens).toContain("Bearer restored-identity-token");
    } finally { await agent.stop(); }
  });

  it("releases signal handlers if preparation of the manager state directory fails", async () => {
    const signals = ["SIGINT", "SIGTERM"] as const, before = signals.map(signal => process.listeners(signal));
    testState.failStateDirectory = true;
    const fetch = vi.fn();
    try {
      await expect(runMaintenanceAgent({ profilePath: "/profile", installRoot: "/install", fetch })).rejects.toThrow("manager state directory fixture");
      expect(signals.map(signal => process.listeners(signal))).toEqual(before);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      for (const [index, signal] of signals.entries()) {
        for (const listener of process.listeners(signal)) if (!before[index]!.includes(listener)) process.removeListener(signal, listener);
      }
    }
  });

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
      expect(agent.settled()).toBe(false); expect(agent.failure()).toBeUndefined();
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
